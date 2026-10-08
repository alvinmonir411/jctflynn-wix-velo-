import wixData from 'wix-data';
import { currentMember } from 'wix-members-frontend';
import { getConferenceRooms } from 'backend/rooms.jsw';

const CONFIG = {
    collectionName: 'RoomBookings',
    roomsCollection: 'Conferanceroom'
};

$w.onReady(function () {
    console.log('[RoomBooking] Book now page onReady initialized');
    try {
        if ($w('#html1').onMessage) {
            $w('#html1').onMessage(async (event) => {
                const { action, payload } = event.data || {};
                console.log('[RoomBooking] Message received from #html1:', action);

                // 1. Fetch conference rooms (pictures & titles) from CMS collection 'Conferanceroom'
                if (action === 'GET_ROOMS' || action === 'GET_CONFERENCE_ROOMS') {
                    await handleGetRooms();
                }

                // 2. Fetch existing bookings for a room & date so the calendar marks booked slots
                if (action === 'GET_BOOKED_SLOTS') {
                    await handleGetBookedSlots(payload);
                }

                // 3. Submit new booking with client details
                if (action === 'SUBMIT_BOOKING') {
                    await handleBookingSubmission(payload);
                }
            });
        }

        // Proactively fetch and push CMS rooms to #html1
        handleGetRooms();
    } catch (e) {
        console.warn('[RoomBooking] #html1 element not found on page:', e);
    }
});

// In-memory cache for CMS conference rooms
let veloRoomsCache = null;

/**
 * Format Wix image URI into a browser-loadable web image URL
 */
function formatWixImageUrl(img) {
    if (!img) return '';
    if (typeof img === 'object' && img !== null) {
        img = img.src || img.url || '';
    }
    if (typeof img !== 'string') return '';
    const trimmed = img.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
        return trimmed;
    }
    if (trimmed.startsWith('wix:image://v1/')) {
        const withoutPrefix = trimmed.replace('wix:image://v1/', '');
        const fileId = withoutPrefix.split('/')[0];
        return `https://static.wixstatic.com/media/${fileId}`;
    }
    if (trimmed.includes('~mv2') || trimmed.match(/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|gif)/i)) {
        return `https://static.wixstatic.com/media/${trimmed}`;
    }
    return trimmed;
}

/**
 * Fetch rooms from CMS collection 'Conferanceroom' and send to #html1
 */
async function handleGetRooms() {
    console.log('[RoomBooking] handleGetRooms called');
    if (veloRoomsCache && veloRoomsCache.length > 0) {
        console.log('[RoomBooking] Serving from cache:', veloRoomsCache.length);
        sendRoomsResponse(veloRoomsCache);
        return;
    }

    try {
        let items = [];
        try {
            items = await getConferenceRooms();
            console.log('[RoomBooking] Backend getConferenceRooms returned:', items ? items.length : 0);
        } catch (backendErr) {
            console.warn('[RoomBooking] Backend query error:', backendErr);
        }

        if (!items || items.length === 0) {
            const candidates = ['Conferanceroom', 'Conferance room', 'ConferanceRoom', 'conferance_room', 'ConferenceRoom', 'Conference room'];
            for (const colId of candidates) {
                try {
                    const res = await wixData.query(colId).limit(50).find();
                    if (res && res.items && res.items.length > 0) {
                        items = res.items;
                        console.log(`[RoomBooking] Direct frontend query on "${colId}" found:`, items.length);
                        break;
                    }
                } catch (queryErr) {
                    // Try next candidate
                }
            }
        }

        if (items && items.length > 0) {
            const rooms = items.map(item => {
                const title = item.title || item.Title || item.name || item.Name || item.roomName || item.RoomName || 'Conference Room';
                let rawImg = item.picture || item.Picture || item.image || item.Image || item.photo || item.Photo || item.roomImage || item.coverImage || item.mainImage || item.img || '';
                const imageUrl = formatWixImageUrl(rawImg);

                return {
                    id: item._id,
                    title: title,
                    image: imageUrl,
                    imageUrl: imageUrl,
                    description: item.description || item.Description || '',
                    capacity: item.capacity || item.Capacity || ''
                };
            });

            console.log('[RoomBooking] Mapped rooms count:', rooms.length);
            veloRoomsCache = rooms;
            sendRoomsResponse(rooms);
        } else {
            console.warn(`[RoomBooking] No rooms found in CMS collection "${CONFIG.roomsCollection}".`);
        }
    } catch (err) {
        console.error('[RoomBooking] Error in handleGetRooms:', err);
    }
}

function sendRoomsResponse(rooms) {
    try {
        console.log('[RoomBooking] Posting ROOMS_RESPONSE to #html1');
        $w('#html1').postMessage({
            action: 'ROOMS_RESPONSE',
            rooms: rooms
        });
    } catch (e) {
        console.error('[RoomBooking] Failed to post rooms to #html1:', e);
    }
}

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

        const dateFormatted = new Date(siteMidnight).toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'America/New_York'
        });

        const s12 = formatTime12(startTime);
        const e12 = formatTime12(endTime);

        // Insert into RoomBookings: strictly 12-hour times and bookingDateText
        await wixData.insert(CONFIG.collectionName, {
            roomName,
            bookingDate: siteMidnight,
            bookingDateText: dateFormatted,
            dateText: dateFormatted,
            startTime: s12,
            endTime: e12,
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

function formatTime12(timeVal) {
    if (!timeVal) return '';
    const s = String(timeVal).trim();
    const match12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
        let h = parseInt(match12[1], 10);
        const m = String(parseInt(match12[2], 10)).padStart(2, '0');
        const ampm = match12[3].toUpperCase();
        if (h === 0) h = 12;
        if (h > 12) h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
    }
    const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
        const h = parseInt(match24[1], 10);
        const m = String(parseInt(match24[2], 10)).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m} ${ampm}`;
    }
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
