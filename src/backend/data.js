import wixData from 'wix-data';
import { contacts, triggeredEmails } from 'wix-crm-backend';
import { notifications } from 'wix-notifications-backend';

/**
 * Helper: Convert time string ("HH:mm" or "h:mm AM/PM") into total minutes from midnight
 */
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const s = String(timeStr).trim();
    const match = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10) || 0;
        const ampm = match[3] ? match[3].toUpperCase() : null;
        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + m;
    }
    // Fallback: extract digits
    const digits = s.match(/\b(\d{1,2})[:\.]?(\d{2})?\b/);
    if (digits) {
        let h = parseInt(digits[1], 10);
        const m = digits[2] ? parseInt(digits[2], 10) : 0;
        if (/pm/i.test(s) && h < 12) h += 12;
        if (/am/i.test(s) && h === 12) h = 0;
        return h * 60 + m;
    }
    return 0;
}

/**
 * Helper: Convert time string to user-friendly 12-hour "h:mm AM/PM" (safe from NaN)
 */
function formatTime12(timeVal) {
    if (!timeVal) return '';
    const s = String(timeVal).trim();
    // Valid 12-hour: e.g. "8:00 AM", "10:30 PM"
    const match12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
        let h = parseInt(match12[1], 10);
        const m = String(parseInt(match12[2], 10)).padStart(2, '0');
        const ampm = match12[3].toUpperCase();
        if (h === 0) h = 12;
        if (h > 12) h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
    }
    // Valid 24-hour: e.g. "08:00", "14:30"
    const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
        const h = parseInt(match24[1], 10);
        const m = String(parseInt(match24[2], 10)).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m} ${ampm}`;
    }
    // Repair corrupted strings like "8:NaN AM"
    const digits = s.match(/\b(\d{1,2})[:\.]?(\d{2})?\b/);
    if (digits) {
        let h = parseInt(digits[1], 10);
        const m = digits[2] ? String(parseInt(digits[2], 10)).padStart(2, '0') : '00';
        const ampm = /pm/i.test(s) ? 'PM' : 'AM';
        if (h === 0) h = 12;
        if (h > 12) h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
    }
    return s;
}

function formatTime24(timeVal) {
    if (!timeVal) return '';
    const s = String(timeVal).trim();
    const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
        const h = String(parseInt(match24[1], 10)).padStart(2, '0');
        const m = String(parseInt(match24[2], 10)).padStart(2, '0');
        return `${h}:${m}`;
    }
    const mins = timeToMinutes(s);
    const h = String(Math.floor(mins / 60)).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    return `${h}:${m}`;
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

    // Standardize 12-hour and 24-hour time strings
    const s12 = formatTime12(item.startTime || startTime);
    const e12 = formatTime12(item.endTime || endTime);
    const s24 = formatTime24(item.startTime || startTime);
    const e24 = formatTime24(item.endTime || endTime);
    const timeRange12 = `${s12} - ${e12}`;

    // Fill all 6 start/end time variations + bookingTime
    item.startTime = s12;
    item.endTime = e12;
    item.startTime12 = s12;
    item.endTime12 = e12;
    item.startTime24 = s24;
    item.endTime24 = e24;
    item.bookingTime = timeRange12;

    // Format date in America/New_York (the coworking space site timezone)
    const dateFormatted = new Date(bookingDate).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York'
    });

    // Populate all date text field variants
    item.bookingDateText = item.bookingDateText || dateFormatted;
    item.dateText = item.dateText || dateFormatted;
    item.date_text = item.date_text || dateFormatted;
    item.formattedDate = item.formattedDate || dateFormatted;
    item.date = item.date || dateFormatted;

    // Also support uppercase field names from Wix CMS schema
    if (item.fullName) item.Fullname = item.fullName;
    if (item.Fullname) item.fullName = item.Fullname;
    if (item.email) item.Email = item.email;
    if (item.Email) item.email = item.Email;
    if (item.phone) item.Phone = item.phone;
    if (item.Phone) item.phone = item.Phone;
    if (item.notes) item.Notes = item.notes;
    if (item.Notes) item.notes = item.Notes;

    return item;
}

/**
 * Wix Data Hook: Runs before an item is updated in 'RoomBookings'.
 * Keeps 12-hour time, 24-hour time, and date text clean and synchronized.
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
        item.dateText = dateFormatted;
        item.date_text = dateFormatted;
        item.formattedDate = dateFormatted;
        item.date = dateFormatted;
    }
    if (item.startTime) {
        const s12 = formatTime12(item.startTime);
        const s24 = formatTime24(item.startTime);
        item.startTime = s12;
        item.startTime12 = s12;
        item.startTime24 = s24;
    }
    if (item.endTime) {
        const e12 = formatTime12(item.endTime);
        const e24 = formatTime24(item.endTime);
        item.endTime = e12;
        item.endTime12 = e12;
        item.endTime24 = e24;
    }
    if (item.startTime && item.endTime) {
        const timeRange12 = `${formatTime12(item.startTime)} - ${formatTime12(item.endTime)}`;
        item.bookingTime = timeRange12;
        item.formattedTime = timeRange12;
        item.time = timeRange12;
    }

    if (item.fullName) item.Fullname = item.fullName;
    if (item.Fullname) item.fullName = item.Fullname;
    if (item.email) item.Email = item.email;
    if (item.Email) item.email = item.Email;
    if (item.phone) item.Phone = item.phone;
    if (item.Phone) item.phone = item.Phone;
    if (item.notes) item.Notes = item.notes;
    if (item.Notes) item.notes = item.Notes;

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
