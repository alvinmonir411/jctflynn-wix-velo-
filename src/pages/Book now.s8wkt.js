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

/**
 * Query booked slots for the selected date & room
 */
async function handleGetBookedSlots(payload) {
    const { roomName, bookingDate } = payload || {};
    if (!roomName || !bookingDate) return;

    try {
        const startOfDay = new Date(bookingDate);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(bookingDate);
        endOfDay.setHours(23, 59, 59, 999);

        const results = await wixData.query(CONFIG.collectionName)
            .eq('roomName', roomName)
            .ge('bookingDate', startOfDay)
            .le('bookingDate', endOfDay)
            .find();

        const bookedSlots = results.items.map(b => ({
            startTime: b.startTime,
            endTime: b.endTime
        }));

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

    // 1. Current member check (optional fallback to guest)
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
        const startOfDay = new Date(bookingDate);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(bookingDate);
        endOfDay.setHours(23, 59, 59, 999);

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
            bookingDate: startOfDay,
            startTime,
            endTime,
            fullName: fullName || '',
            email: email || '',
            phone: phone || '',
            notes: notes || '',
            memberId
        });

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
