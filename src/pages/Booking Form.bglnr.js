import wixData from 'wix-data';
import { currentMember } from 'wix-members-frontend';

const CONFIG = {
    collectionName: 'RoomBookings'
};

$w.onReady(function () {
    try {
        if ($w('#html1').onMessage) {
            $w('#html1').onMessage(async (event) => {
                const { action, payload } = event.data || {};

                // 1. Fetch existing bookings for a room & date so the calendar marks booked slots
                if (action === 'GET_BOOKED_SLOTS') {
                    await handleGetBookedSlots(payload);
                }

                // 2. Submit new booking with client details
                if (action === 'SUBMIT_BOOKING') {
                    await handleBookingSubmission(payload);
                }
            });
        }
    } catch (e) {
        // #html1 not present
    }
});

// In-memory slots cache to make repeat requests 0ms instant
const veloSlotsCache = {};

/**
 * Safely calculate Eastern Time (EDT/EST) midnight and full-day bounds
 * for the coworking space site in America/New_York.
 * Guarantees that bookingDate is ALWAYS saved and displayed as 12:00 AM on that exact date in Wix CMS.
 */
function getSiteDateBounds(dateStr) {
    if (!dateStr) return { siteMidnight: new Date(), startOfDay: new Date(), endOfDay: new Date() };
    const [y, m, d] = dateStr.split('-').map(Number);

    // Determine whether America/New_York is in EDT (-4h) or EST (-5h) on that calendar date
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const nyStr = noonUtc.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
    const offsetHours = nyStr.includes('EDT') ? 4 : 5;

    // Midnight in America/New_York (displays as 12:00 AM in Wix CMS on the exact calendar day)
    const siteMidnight = new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0, 0));
    // End of day in America/New_York (11:59:59.999 PM)
    const siteEndOfDay = new Date(Date.UTC(y, m - 1, d + 1, offsetHours, 0, 0, 0) - 1);

    return { siteMidnight, startOfDay: siteMidnight, endOfDay: siteEndOfDay };
}

/**
 * Query booked slots for the selected date & room
 */
async function handleGetBookedSlots(payload) {
    const { roomName, bookingDate } = payload || {};
    if (!roomName || !bookingDate) return;

    const cacheKey = `${roomName}_${bookingDate}`;
    if (veloSlotsCache[cacheKey]) {
        $w('#html1').postMessage({
            action: 'BOOKED_SLOTS_RESPONSE',
            roomName: roomName,
            bookingDate: bookingDate,
            bookedSlots: veloSlotsCache[cacheKey]
        });
        return;
    }

    try {
        const { startOfDay, endOfDay } = getSiteDateBounds(bookingDate);

        const results = await wixData.query(CONFIG.collectionName)
            .eq('roomName', roomName)
            .ge('bookingDate', startOfDay)
            .le('bookingDate', endOfDay)
            .limit(100)
            .find();

        const bookedSlots = results.items.map(b => ({
            startTime: b.startTime,
            endTime: b.endTime
        }));

        veloSlotsCache[cacheKey] = bookedSlots;

        $w('#html1').postMessage({
            action: 'BOOKED_SLOTS_RESPONSE',
            roomName: roomName,
            bookingDate: bookingDate,
            bookedSlots: bookedSlots
        });
    } catch (err) {
        console.error('Error fetching booked slots:', err);
        $w('#html1').postMessage({
            action: 'BOOKED_SLOTS_RESPONSE',
            roomName: roomName,
            bookingDate: bookingDate,
            bookedSlots: []
        });
    }
}

/**
 * Submit booking with overlap validation and client details
 */
async function handleBookingSubmission(data) {
    const { roomName, bookingDate, startTime, endTime, fullName, email, phone, notes } = data || {};

    let memberId = 'guest';
    try {
        const member = await currentMember.getMember();
        if (member) {
            memberId = member._id;
        }
    } catch (e) {
        // Guest user booking
    }

    try {
        const { siteMidnight, startOfDay, endOfDay } = getSiteDateBounds(bookingDate);

        // Overlap verification
        const results = await wixData.query(CONFIG.collectionName)
            .eq('roomName', roomName)
            .ge('bookingDate', startOfDay)
            .le('bookingDate', endOfDay)
            .find();

        const reqStart = timeToMinutes(startTime);
        const reqEnd = timeToMinutes(endTime);

        const hasOverlap = results.items.some(existing => {
            const existStart = timeToMinutes(existing.startTime);
            const existEnd = timeToMinutes(existing.endTime);
            return reqStart < existEnd && reqEnd > existStart;
        });

        if (hasOverlap) {
            sendResponse(false, "This time slot was just booked by someone else. Please choose another time.");
            return;
        }

        // Insert into RoomBookings
        await wixData.insert(CONFIG.collectionName, {
            roomName,
            bookingDate: siteMidnight,
            startTime,
            endTime,
            fullName: fullName || '',
            email: email || '',
            phone: phone || '',
            notes: notes || '',
            memberId
        });

        // Invalidate cache for this room & date so new slot is immediately reflected
        delete veloSlotsCache[`${roomName}_${bookingDate}`];

        sendResponse(true, "Booking confirmed! Your room is successfully reserved.");

    } catch (err) {
        console.error("Booking submission error:", err);
        sendResponse(false, err.message || "An error occurred while saving your booking. Please try again.");
    }
}

function sendResponse(success, message) {
    $w('#html1').postMessage({
        action: 'BOOKING_RESPONSE',
        success,
        message
    });
}

function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}
