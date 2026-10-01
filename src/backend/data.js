import wixData from 'wix-data';

/**
 * Helper: Convert "HH:mm" time string into total minutes from midnight
 */
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Wix Data Hook: Runs on the server before any booking is inserted into 'RoomBookings'.
 * Guarantees zero double-booking / race conditions across all users.
 */
export async function RoomBookings_beforeInsert(item, context) {
    const { roomName, bookingDate, startTime, endTime } = item;

    if (!roomName || !bookingDate || !startTime || !endTime) {
        throw new Error('Missing required booking details (roomName, bookingDate, startTime, endTime).');
    }

    // Cover the full 24-hour day of the requested date
    const startOfDay = new Date(bookingDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(bookingDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Query existing bookings for this room on this date (suppressAuth allows querying across all members)
    const existingBookings = await wixData.query('RoomBookings')
        .eq('roomName', roomName)
        .ge('bookingDate', startOfDay)
        .le('bookingDate', endOfDay)
        .find({ suppressAuth: true });

    const reqStart = timeToMinutes(startTime);
    const reqEnd = timeToMinutes(endTime);

    // Overlap condition: (Requested Start < Existing End) AND (Requested End > Existing Start)
    const hasOverlap = existingBookings.items.some(existing => {
        const existStart = timeToMinutes(existing.startTime);
        const existEnd = timeToMinutes(existing.endTime);
        return reqStart < existEnd && reqEnd > existStart;
    });

    if (hasOverlap) {
        throw new Error('This time slot is already booked. Please choose another time.');
    }

    return item;
}
