const axios = require('axios');
const { google } = require('googleapis');

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Only POST requests allowed' });
    }

    const { action } = request.body;
    const dataToSendToOneC = request.body;

    try {
        console.log(`Отправка в 1С для действия "${action}":`, JSON.stringify(dataToSendToOneC, null, 2));
        
        const responseFrom1C = await forwardRequestToOneC(dataToSendToOneC);
        
        console.log('ПОЛУЧЕН ОТВЕТ ОТ 1С:', JSON.stringify(responseFrom1C, null, 2));

        if (responseFrom1C.status === 'success' && responseFrom1C.data) {
            if (action === 'saveNewMeeting' || action === 'updateMeeting') {
                // --- ИЗМЕНЕНИЕ: Добавлено 'await' ---
                // Теперь мы ждем, пока работа с календарем полностью завершится
                await handleCalendarEvent(action, responseFrom1C.data);
            }
        }

        // Ответ браузеру отправляется только после того, как все операции завершены
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

// ЗАМЕНИТЕ ВАШУ ФУНКЦИЮ handleCalendarEvent НА ЭТУ
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
        start: {
            dateTime: startTimeStr,
            timeZone: 'Europe/Kiev'
        },
        end: {
            dateTime: endTimeStr,
            timeZone: 'Europe/Kiev'
        }
    };

    try {
        if (meeting.calendarEventId) {
            await calendar.events.update({ auth, calendarId: 'primary', eventId: meeting.calendarEventId, resource: eventResource });
            console.log(`Событие ${meeting.calendarEventId} успешно обновлено.`);
        } else {
            const newEvent = await calendar.events.insert({ auth, calendarId: 'primary', resource: eventResource });
            console.log(`Создано новое событие в Google Calendar: ${newEvent.data.id}.`);
            
            // --- НАЧАЛО ИСПРАВЛЕННОЙ ЛОГИКИ ---
            const payloadTo1C = { action: "updateMeetingCalendarId", payload: { meetingId: meeting.ID, calendarEventId: newEvent.data.id } };
            
            try {
                console.log('Отправляем ID события из календаря в 1С...');
                await forwardRequestToOneC(payloadTo1C); // ДОБАВЛЕНО AWAIT
                console.log('ID события календаря успешно сохранен в 1С.');
            } catch (e) {
                // Логируем ошибку именно этого, второго запроса
                console.error('!!! ОШИБКА при отправке calendarEventId в 1С:', e.message);
            }
            // --- КОНЕЦ ИСПРАВЛЕННОЙ ЛОГИКИ ---
        }
    } catch (e) {
        console.error('--- ОШИБКА GOOGLE CALENDAR API ---');
        console.error('Действие:', action);
        console.error('Данные встречи:', JSON.stringify(meeting, null, 2));
        console.error('Сообщение об ошибке:', e.message);
        console.error('------------------------------------');
    }
}

// ЗАМЕНИТЕ ВАШУ ФУНКЦИЮ parseDateTime НА ЭТУ НОВУЮ ВЕРСИЮ
function parseDateTimeToStrings(dateStr, timeStr) {
    const [day, month, year] = dateStr.split('.');
    
    // Формируем строку времени начала в формате, нужном Google
    const startTimeStr = `${year}-${month}-${day}T${timeStr}:00`;

    // Корректно вычисляем время окончания (на 1 час позже)
    const [hours, minutes] = timeStr.split(':');
    // new Date() здесь используется только для безопасного расчета времени
    const startDate = new Date(year, month - 1, day, hours, minutes);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    
    const pad = (num) => num.toString().padStart(2, '0');
    const endTimeStr = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}` +
                     `T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;

    return [startTimeStr, endTimeStr];
}
