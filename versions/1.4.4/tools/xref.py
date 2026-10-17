#!/usr/bin/env python3
"""xref.py: string cross-references and annotated disassembly for a Windows PE executable.

Re-implementation of the tool described in docs/tools.md (not yet committed upstream). Only point
it at a file you own; it only reads the file and never modifies it.

Usage:
    xref.py <exe> find <text>               locate a string and every lea that points at it
    xref.py <exe> func <hex address> [n]    disassemble from an address, annotating string refs

Requires: pip install pefile capstone
"""

import sys

import pefile
import capstone
from capstone import x86

IMAGE_SCN_MEM_EXECUTE = 0x20000000


def load(path):
    return pefile.PE(path, fast_load=True)


def image_bytes(pe):
    # Indexed by RVA (== VA - ImageBase), padded to the image's virtual layout
    return pe.get_memory_mapped_image()


def va_to_rva(pe, va):
    return va - pe.OPTIONAL_HEADER.ImageBase


def rva_to_va(pe, rva):
    return rva + pe.OPTIONAL_HEADER.ImageBase


def section_name(section):
    return section.Name.rstrip(b"\x00").decode(errors="replace")


def section_for_rva(pe, rva):
    for section in pe.sections:
        size = max(section.Misc_VirtualSize, section.SizeOfRawData)
        if section.VirtualAddress <= rva < section.VirtualAddress + size:
            return section
    return None


def find_string_occurrences(data, text):
    """Yield (encoding, rva) for every occurrence of text, as ASCII and as UTF-16LE."""
    needles = (("ascii", text.encode("ascii", errors="ignore")), ("utf16", text.encode("utf-16-le")))

    for encoding, needle in needles:
        if not needle:
            continue
        start = 0
        while True:
            index = data.find(needle, start)
            if index == -1:
                break
            yield encoding, index
            start = index + 1


def scan_lea_xrefs(pe, data, target_rva):
    """RIP-relative lea instructions (48 8D or 4C 8D, mod=00 rm=101) whose target is target_rva."""
    results = []

    for section in pe.sections:
        if not (section.Characteristics & IMAGE_SCN_MEM_EXECUTE):
            continue

        start = section.VirtualAddress
        size = min(section.Misc_VirtualSize, section.SizeOfRawData) or section.Misc_VirtualSize
        chunk = data[start:start + size]
        length = len(chunk)

        for offset in range(0, max(length - 6, 0)):
            if chunk[offset] not in (0x48, 0x4C) or chunk[offset + 1] != 0x8D:
                continue

            modrm = chunk[offset + 2]
            if (modrm & 0xC7) != 0x05:  # mod==00, rm==101: RIP-relative, no SIB
                continue

            disp = int.from_bytes(chunk[offset + 3:offset + 7], "little", signed=True)
            insn_rva = start + offset
            target_rva_here = insn_rva + 7 + disp

            if target_rva_here == target_rva:
                results.append(insn_rva)

    return results


def find_function_start(data, insn_rva, section_start):
    """Walk back to the nearest run of int3 (0xCC) padding: an estimated function start."""
    pos = insn_rva
    while pos > section_start:
        if data[pos - 1] == 0xCC:
            return pos
        pos -= 1
    return section_start


def cmd_find(pe, text):
    data = image_bytes(pe)

    for encoding, rva in find_string_occurrences(data, text):
        section = section_for_rva(pe, rva)
        name = section_name(section) if section else "?"
        print(f"[{encoding}] {name} {hex(rva_to_va(pe, rva))}")

        for xref_rva in scan_lea_xrefs(pe, data, rva):
            xref_section = section_for_rva(pe, xref_rva)
            start = xref_section.VirtualAddress if xref_section else 0
            func_rva = find_function_start(data, xref_rva, start)
            print(f"    xref {hex(rva_to_va(pe, xref_rva))}   func~{hex(rva_to_va(pe, func_rva))}")


def read_cstring(data, rva, encoding, limit=400):
    if rva < 0 or rva >= len(data):
        return None

    end = rva
    if encoding == "ascii":
        while end < len(data) and data[end] != 0 and end - rva < limit:
            end += 1
        raw = data[rva:end]
        try:
            text = raw.decode("ascii")
        except UnicodeDecodeError:
            return None
    else:
        while end + 1 < len(data) and not (data[end] == 0 and data[end + 1] == 0) and end - rva < limit * 2:
            end += 2
        raw = data[rva:end]
        try:
            text = raw.decode("utf-16-le")
        except UnicodeDecodeError:
            return None

    return text


def annotate_target(data, target_rva):
    """Read the lea target as a C string for the disassembly annotation, if it looks like one."""
    utf16 = read_cstring(data, target_rva, "utf16")
    if utf16 and len(utf16) >= 2 and all(32 <= ord(c) < 127 or c in "\t\n\r" for c in utf16):
        return f'w"{utf16}"'

    ascii_text = read_cstring(data, target_rva, "ascii")
    if ascii_text and len(ascii_text) >= 2 and all(32 <= ord(c) < 127 for c in ascii_text):
        return f'a"{ascii_text}"'

    return None


def cmd_func(pe, address, count):
    data = image_bytes(pe)
    rva = va_to_rva(pe, address)

    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True

    code = data[rva:rva + count * 12]

    for insn in md.disasm(code, address):
        line = f"0x{insn.address:x}  {insn.mnemonic:<7} {insn.op_str}"

        if insn.mnemonic == "lea":
            for operand in insn.operands:
                if operand.type == x86.X86_OP_MEM and operand.mem.base == x86.X86_REG_RIP:
                    target_va = insn.address + insn.size + operand.mem.disp
                    annotation = annotate_target(data, va_to_rva(pe, target_va))
                    line += f"   ; {annotation if annotation else hex(target_va)}"

        print(line)

        if insn.mnemonic == "ret":
            break


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    pe = load(sys.argv[1])
    command = sys.argv[2]

    if command == "find":
        if len(sys.argv) < 4:
            print("usage: xref.py <exe> find <text>")
            sys.exit(1)
        cmd_find(pe, sys.argv[3])
    elif command == "func":
        if len(sys.argv) < 4:
            print("usage: xref.py <exe> func <hex address> [n]")
            sys.exit(1)
        address = int(sys.argv[3], 16)
        count = int(sys.argv[4]) if len(sys.argv) > 4 else 400
        cmd_func(pe, address, count)
    else:
        print(f"unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
