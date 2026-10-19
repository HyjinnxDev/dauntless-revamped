import assert from "node:assert/strict";
import test from "node:test";
import { PickTravelHost } from "./travelHost";

const PUBLIC = "202.137.167.182";
const LOCAL = ["192.168.1.39", "100.80.1.2"];

test("travel host per client network", () => {
    assert.equal(PickTravelHost("::ffff:202.137.167.182", PUBLIC, LOCAL), "127.0.0.1");
    assert.equal(PickTravelHost("192.168.1.39", PUBLIC, LOCAL), "127.0.0.1");
    assert.equal(PickTravelHost("::ffff:192.168.1.21", PUBLIC, LOCAL), "192.168.1.39");
    assert.equal(PickTravelHost("100.108.36.34", PUBLIC, LOCAL), "100.80.1.2");
    assert.equal(PickTravelHost("10.0.0.5", PUBLIC, LOCAL), PUBLIC);
    assert.equal(PickTravelHost("8.8.8.8", PUBLIC, LOCAL), PUBLIC);
});
