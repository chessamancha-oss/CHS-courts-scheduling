function bookingsDoNotConflict(proposedStart, proposedEnd, existingStart, existingEnd, proposedCourt, existingCourt, proposedDate, existingDate) {
    if (proposedDate === existingDate) {
        if (proposedCourt === existingCourt) {
            if (proposedStart < existingEnd && proposedEnd > existingStart) {
                return false;
            } else {
                return true;
            }
        } else {
            return true;
        }
    } else {
        return true;
    }
}

const proposed = {
    start: 600,
    end: 660,
    court: 2,
    date: "2026-10-11",
    clientId: "browser_123",
    status: "active"
};

const existingBookings = [
    {
        start: 480,
        end: 540,
        court: 2,
        date: "2026-10-11",
        clientId: "browser_123",
        status: "active"
    },
    {
        start: 540,
        end: 600,
        court: 2,
        date: "2026-10-11",
        clientId: "browser_123",
        status: "active"
    },
    {
        start: 630,
        end: 690,
        court: 2,
        date: "2026-10-11",
        clientId: "browser_456",
        status: "active"
    },
    {
        start: 600,
        end: 660,
        court: 4,
        date: "2026-10-11",
        clientId: "browser_123",
        status: "canceled"
    }
];

function isUnderDailyLimit(proposed, existingBookings) {
    let count = 0;

    for (const existing of existingBookings) {
        if (existing.date === proposed.date && existing.clientId === proposed.clientId && existing.status === "active") {
            count++;
        }
    }

    return count < 2;
}

const testCases = [
    {
        name: "same-court overlap should fail",
        proposed: { start: 600, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [
            { start: 630, end: 690, court: 2, date: "2026-10-11" }
        ],
        expected: false
    },
    {
        name: "canceled overlapping booking should be ignored",
        proposed: { start: 600, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [
            { start: 630, end: 690, court: 2, date: "2026-10-11", status: "canceled" }
        ],
        expected: true
    },
    {
        name: "third active booking on same day should fail",
        proposed: {
            start: 720,
            end: 780,
            court: 3,
            date: "2026-10-11",
            clientId: "browser_123",
            status: "active"
        },
        existingBookings: [
            {
                start: 480,
                end: 540,
                court: 1,
                date: "2026-10-11",
                clientId: "browser_123",
                status: "active"
            },
            {
                start: 600,
                end: 660,
                court: 2,
                date: "2026-10-11",
                clientId: "browser_123",
                status: "active"
            }
        ],
        expected: false
    },
    {
        name: "different court should pass",
        proposed: { start: 600, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [
            { start: 630, end: 690, court: 3, date: "2026-10-11" }
        ],
        expected: true
    },
    {
        name: "different date should pass",
        proposed: { start: 600, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [
            { start: 630, end: 690, court: 2, date: "2026-10-12" }
        ],
        expected: true
    },
    {
        name: "invalid duration should fail",
        proposed: { start: 600, end: 700, court: 2, date: "2026-10-11" },
        existingBookings: [],
        expected: false
    },
    {
        name: "touching bookings should pass",
        proposed: { start: 600, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [
            { start: 660, end: 720, court: 2, date: "2026-10-11" }
        ],
        expected: true
    },
    {
        name: "invalid court 7 should fail",
        proposed: { start: 600, end: 660, court: 7, date: "2026-10-11" },
        existingBookings: [],
        expected: false
    },
    {
        name: "invalid start 615 should fail",
        proposed: { start: 615, end: 660, court: 2, date: "2026-10-11" },
        existingBookings: [],
        expected: false
    },
    {
        name: "valid 30 minute booking should pass",
        proposed: { start: 600, end: 630, court: 2, date: "2026-10-11" },
        existingBookings: [],
        expected: true
    }
];

function validateBooking(proposed, existingBookings) {
    if (!isUnderDailyLimit(proposed, existingBookings)) {
        return false;
    }

    const duration = proposed.end - proposed.start;
    if (proposed.start < 0 || proposed.court > 6 || proposed.court < 1 || proposed.start % 30 !== 0 || proposed.end % 30 !== 0 || proposed.end > 1440 || proposed.end <= proposed.start || [30, 60, 90, 120].includes(duration) === false) {
        return false;
    } else {
        for (const existing of existingBookings) {
            if (existing.status === "canceled") {
                continue;
            }
            if (!bookingsDoNotConflict(proposed.start, proposed.end, existing.start, existing.end, proposed.court, existing.court, proposed.date, existing.date)) {
                return false;
            }
        }
    }
    return true;
}

if (typeof window === "undefined") {
    let failureCount = 0;

    for (const testCase of testCases) {
        const actual = validateBooking(
            testCase.proposed,
            testCase.existingBookings
        );

        const passed = actual === testCase.expected;

        if (!passed) {
            failureCount++;
        }

        console.log(
            `${passed ? "PASS" : "FAIL"} — ${testCase.name}`
        );
    }

    if (failureCount > 0) {
        process.exitCode = 1;
    }
}
