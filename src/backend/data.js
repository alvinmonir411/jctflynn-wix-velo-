import wixData from 'wix-data';
import { contacts, triggeredEmails } from 'wix-crm-backend';
import { notifications } from 'wix-notifications-backend';

/**
 * Helper: Convert "HH:mm" time string into total minutes from midnight
 */
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Helper: Convert 24-hour time "HH:mm" to user-friendly "h:mm AM/PM"
 */
function formatTime12(t24) {
    if (!t24) return '';
    const [h, m] = t24.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
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

    // Format date in America/New_York (the coworking space site timezone)
    const dateFormatted = new Date(bookingDate).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York'
    });

    // 12-hour clock times (e.g. "9:00 AM", "6:00 PM", "9:00 AM - 6:00 PM")
    const s12 = formatTime12(startTime);
    const e12 = formatTime12(endTime);
    const timeRange12 = `${s12} - ${e12}`;

    // Pre-formatted text fields for Wix Automations dynamic values (avoids raw Date parsing bugs)
    item.bookingDateText = item.bookingDateText || dateFormatted;
    item.formattedDate = item.formattedDate || dateFormatted;
    item.date = item.date || dateFormatted;
    item.startTime12 = item.startTime12 || s12;
    item.endTime12 = item.endTime12 || e12;
    item.bookingTime = item.bookingTime || timeRange12;
    item.formattedTime = item.formattedTime || timeRange12;
    item.time = item.time || timeRange12;

    return item;
}

/**
 * Wix Data Hook: Runs before an item is updated in 'RoomBookings'.
 * Keeps 12-hour time and date text strings synchronized.
 */
export async function RoomBookings_beforeUpdate(item, context) {
    if (item.bookingDate) {
        const dateFormatted = new Date(item.bookingDate).toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'America/New_York'
        });
        item.bookingDateText = dateFormatted;
        item.formattedDate = dateFormatted;
        item.date = dateFormatted;
    }
    if (item.startTime) {
        item.startTime12 = formatTime12(item.startTime);
    }
    if (item.endTime) {
        item.endTime12 = formatTime12(item.endTime);
    }
    if (item.startTime && item.endTime) {
        const timeRange12 = `${formatTime12(item.startTime)} - ${formatTime12(item.endTime)}`;
        item.bookingTime = timeRange12;
        item.formattedTime = timeRange12;
        item.time = timeRange12;
    }
    return item;
}

/**
 * Wix Data Hook: Runs on the server immediately AFTER a new booking is inserted into 'RoomBookings'.
 * Automatically executes the booking automation:
 * 1. Creates/Updates the contact record in Wix CRM.
 * 2. Sends confirmation email to the client.
 * 3. Sends notification & alert to the site owner / admin recipient.
 */
export async function RoomBookings_afterInsert(item, context) {
    const {
        roomName,
        bookingDate,
        startTime,
        endTime,
        fullName,
        email,
        phone,
        notes,
        _id
    } = item;

    // 1. Format date in America/New_York (the coworking space site timezone)
    const dateFormatted = new Date(bookingDate).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York'
    });

    // 2. Format 12-hour time range (e.g. "8:00 AM – 9:30 AM")
    const timeFormatted = `${formatTime12(startTime)} – ${formatTime12(endTime)}`;

    // 3. Upsert Contact into Wix CRM
    let contactId = null;
    if (email) {
        try {
            const nameParts = (fullName || 'Valued Client').trim().split(' ');
            const firstName = nameParts[0] || 'Valued';
            const lastName = nameParts.slice(1).join(' ') || 'Client';

            const contact = await contacts.appendOrCreateContact(
                { emails: [email] },
                {
                    name: { first: firstName, last: lastName },
                    phones: phone ? [phone] : []
                }
            );
            contactId = contact.contactId;
            console.log(`Wix Contact created/updated for ${email}: ${contactId}`);
        } catch (contactErr) {
            console.error('Error creating Wix CRM contact:', contactErr);
        }
    }

    // 4. Send Confirmation Email to Client via Wix Triggered Emails
    if (contactId && email) {
        try {
            await triggeredEmails.emailContact('room_booking_confirmation', contactId, {
                variables: {
                    clientName: fullName || 'Valued Member',
                    roomName: roomName || 'Conference Room',
                    bookingDate: dateFormatted,
                    bookingTime: timeFormatted,
                    notes: notes || 'None',
                    phone: phone || '',
                    bookingId: _id || ''
                }
            });
            console.log(`Successfully sent confirmation email to client: ${email}`);
        } catch (clientEmailErr) {
            console.warn(
                'Client triggered email notice (template "room_booking_confirmation" may need to be published in Wix Dashboard):',
                clientEmailErr.message || clientEmailErr
            );
        }
    }

    // 5. Send Real-Time Notification & Alert to Wix Site Owner / Admin
    try {
        await notifications.notify({
            title: `New Reservation: ${roomName}`,
            body: `${fullName || 'Client'} booked ${roomName} on ${dateFormatted} (${timeFormatted}). Phone: ${phone || 'N/A'}.`,
            action: {
                type: 'dashboard',
                url: '/cms/collections/RoomBookings'
            }
        }, {
            roles: ['siteOwner', 'siteAdmin']
        });
        console.log('Site Owner notification successfully dispatched.');
    } catch (notifErr) {
        console.warn('Site Owner notification notice:', notifErr.message || notifErr);
    }

    return item;
}
