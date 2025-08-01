const axios = require('axios');
const { google } = require('googleapis');

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Only POST requests allowed' });
    }

  const dataToSendToOneC = request.body;

    try {
        console.log(`Отправка в 1С для действия "${action}":`, JSON.stringify(dataToSendToOneC, null, 2));
        
        const responseFrom1C = await forwardRequestToOneC(dataToSendToOneC);

        if (responseFrom1C.status === 'success') {
            const meetingData = (action === 'saveNewMeeting') ? responseFrom1C.data : payload.newData;
            handleCalendarEvent(action, meetingData);
        }

        response.status(200).json(responseFrom1C);

    } catch (error) {
        console.error("Proxy error:", error.message);
        if (error.response) {
            response.status(error.response.status).json(error.response.data);
        } else {
            response.status(500).json({ status: 'error', message: 'Ошибка прокси-сервера при обращении к 1С' });
        }
    }
}

// --- Остальные функции (forwardRequestToOneC, getGoogleAuth, и т.д.) остаются БЕЗ ИЗМЕНЕНИЙ ---

async function forwardRequestToOneC(requestBody) {
    const ONEC_API_URL = process.env.ONEC_API_URL;
    const ONEC_LOGIN = process.env.ONEC_LOGIN;
    const ONEC_PASSWORD = process.env.ONEC_PASSWORD;

    const headers = { 'Content-Type': 'application/json' };
    if (ONEC_LOGIN && ONEC_PASSWORD) {
        const token = Buffer.from(`${ONEC_LOGIN}:${ONEC_PASSWORD}`).toString('base64');
        headers['Authorization'] = `Basic ${token}`;
    }
    
    const apiResponse = await axios.post(ONEC_API_URL, requestBody, { headers });
    return apiResponse.data;
}

function getGoogleAuth(userEmail) {
    const auth = new google.auth.JWT({
        email: process.env.GAPI_CLIENT_EMAIL,
        key: process.env.GAPI_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/calendar'],
        subject: userEmail,
    });
    return auth;
}

async function handleCalendarEvent(action, meeting) {
    if (!meeting || !meeting.ManagerLogin || (action !== 'saveNewMeeting' && action !== 'updateMeeting')) {
        return;
    }
    const auth = getGoogleAuth(meeting.ManagerLogin);
    const calendar = google.calendar({ version: 'v3', auth });
    const isCancelled = (meeting.Status === 'Отмена' || meeting.Status === 'Завершена');

    if (isCancelled && meeting.calendarEventId) {
        try {
            await calendar.events.delete({ auth, calendarId: 'primary', eventId: meeting.calendarEventId });
        } catch (e) { console.error(`Не удалось удалить событие ${meeting.calendarEventId}:`, e.message); }
        return;
    }
    if (isCancelled) return;

    const [startTime, endTime] = parseDateTime(meeting.Date, meeting.Time);
    const eventResource = {
        summary: `Встреча: ${meeting.Client}`,
        description: `Цель: ${meeting.Purpose}\nМенеджер: ${meeting.ManagerLogin}`,
        location: meeting.Location || '',
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() }
    };
    try {
        if (action === 'updateMeeting' && meeting.calendarEventId) {
            await calendar.events.update({ auth, calendarId: 'primary', eventId: meeting.calendarEventId, resource: eventResource });
        } else {
            const newEvent = await calendar.events.insert({ auth, calendarId: 'primary', resource: eventResource });
            const payloadTo1C = { action: "updateMeetingCalendarId", payload: { meetingId: meeting.ID, calendarEventId: newEvent.data.id } };
            forwardRequestToOneC(payloadTo1C);
        }
    } catch (e) {
        console.error('Ошибка при работе с Google Calendar API:', e.message);
    }
}

function parseDateTime(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('.');
    const [hours, minutes] = timeStr.split(':');
    const startTime = new Date(year, month - 1, day, hours, minutes);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
    return [startTime, endTime];
}
