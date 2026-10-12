CREATE TABLE `huntcompletions` (
    `accountId` text NOT NULL,
    `completionId` text NOT NULL,
    `characterId` text NOT NULL,
    `huntId` text NOT NULL,
    `platinum` integer NOT NULL,
    `completedDate` text NOT NULL,
    PRIMARY KEY (`accountId`, `completionId`)
);
--> statement-breakpoint
CREATE TABLE `huntpassplatinum` (
    `accountId` text NOT NULL,
    `progressionScope` text NOT NULL,
    `quantity` integer NOT NULL,
    PRIMARY KEY (`accountId`, `progressionScope`)
);
