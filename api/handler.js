// Используем единый стиль 'require' для всех библиотек
const Sentry = require('@sentry/node');
const { ProfilingIntegration } = require("@sentry/profiling-node");
const axios = require('axios');
const { google } = require('googleapis');

// Инициализируем Sentry СРАЗУ ЖЕ. 
// Vercel выполнит этот код один раз при "холодном старте" функции.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [ new ProfilingIntegration() ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

// Основная логика вынесена в отдельную async функцию
async function mainHandler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Only POST requests allowed' });
    }

    // Блок try/catch остается внутри, но теперь он будет работать под "присмотром" Sentry
    try {
        const { action } = request.body;
        const dataToSendToOneC = request.body;

        console.log(`[ШАГ 1] Отправка в 1С для действия "${action}":`, JSON.stringify(dataToSendToOneC, null, 2));
        const responseFrom1C = await forwardRequestToOneC(dataToSendToOneC);
        console.log('[ШАГ 2] ПОЛУЧЕН ОТВЕТ ОТ 1С:', JSON.stringify(responseFrom1C, null, 2));

        if (responseFrom1C.status === 'success' && responseFrom1C.data) {
            if (action === 'saveNewMeeting' || action === 'updateMeeting') {
                await handleCalendarEvent(action, responseFrom1C.data);
            }
        }

        response.status(200).json(responseFrom1C);

    } catch (error) {
        // Эта ошибка теперь будет поймана Sentry.withSentry
        console.error("!!! КРИТИЧЕСКАЯ ОШИБКА ОБРАБОТЧИКА:", error.message);
        
        // Эта часть важна, чтобы браузер получил корректный ответ
        if (error.response && error.response.status) {
            response.status(error.response.status).json(error.response.data || { message: 'Ошибка от сервера 1С' });
        } else {
            response.status(500).json({ status: 'error', message: 'Внутренняя ошибка сервера Vercel' });
        }
        
        // Мы "пробрасываем" ошибку дальше, чтобы обертка Sentry.withSentry ее поймала
        throw error;
    }
}


// Вспомогательные функции остаются без изменений ...
async function forwardRequestToOneC(requestBody) {
    // ... этот код остается без изменений ...
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
    // ... этот код остается без изменений ...
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

    const isCancelled = (meeting.Status === 'Отмена' || meeting.Status === 'Отменено' || meeting.Status === 'Завершена' || meeting.Status === 'Завершено');

    if (isCancelled && meeting.calendarEventId) {
        try {
            await calendar.events.delete({ auth, calendarId: 'primary', eventId: meeting.calendarEventId });
            console.log(`Событие ${meeting.calendarEventId} успешно удалено.`);
        } catch (e) { console.error(`Не удалось удалить событие ${meeting.calendarEventId}:`, e.message); }
        return;
    }
    if (isCancelled) return;

    const [startTimeStr, endTimeStr] = parseDateTimeToStrings(meeting.Date, meeting.Time);
    const eventResource = {
        summary: `Встреча: ${meeting.Client}`,
        description: `Цель: ${meeting.Purpose}\nМенеджер: ${meeting.ManagerLogin}`,
        location: meeting.Location || '',
        start: { dateTime: startTimeStr, timeZone: 'Europe/Kiev' },
        end: { dateTime: endTimeStr, timeZone: 'Europe/Kiev' }
    };

    try {
        if (meeting.calendarEventId) {
            await calendar.events.update({ auth, calendarId: 'primary', eventId: meeting.calendarEventId, resource: eventResource });
            console.log(`Событие ${meeting.calendarEventId} успешно обновлено.`);
        } else {
            const newEvent = await calendar.events.insert({ auth, calendarId: 'primary', resource: eventResource });
            console.log(`[ШАГ 4] Создано новое событие в Google Calendar: ${newEvent.data.id}.`);
            
            const payloadTo1C = { action: "updateMeetingCalendarId", payload: { meetingId: meeting.ID, calendarEventId: newEvent.data.id } };
            
            console.log('[ШАГ 5] Отправляем ID события из календаря в 1С...');
            await forwardRequestToOneC(payloadTo1C);
            console.log('[ШАГ 5.1] ID события календаря успешно сохранен в 1С.');
        }
    } catch (e) {
        console.error('--- ОШИБКА ВНУТРИ handleCalendarEvent ---');
        console.error('Сообщение об ошибке:', e.message);
        console.error('------------------------------------');
        // Пробрасываем ошибку выше, чтобы главный обработчик ее поймал
        throw e;
    }
}

function parseDateTimeToStrings(dateStr, timeStr) {
    // ... этот код остается без изменений ...
    const [day, month, year] = dateStr.split('.');
    const startTimeStr = `${year}-${month}-${day}T${timeStr}:00`;
    const [hours, minutes] = timeStr.split(':');
    const startDate = new Date(year, month - 1, day, hours, minutes);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const pad = (num) => num.toString().padStart(2, '0');
    const endTimeStr = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
    return [startTimeStr, endTimeStr];

// --- ИЗМЕНЕНИЕ 3: САМОЕ ГЛАВНОЕ ---
// САМОЕ ГЛАВНОЕ: Экспортируем нашу функцию, обернутую в Sentry.
// Этот экспорт должен быть единственным в файле.
module.exports = Sentry.withSentry(mainHandler);
