const axios = require('axios');
const { google } = require('googleapis');

// --- ОСНОВНОЙ ОБРАБОТЧИК ---
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Only POST requests allowed' });
  }

  const { action, payload } = request.body;

  try {
    // 1. Перенаправляем запрос в 1С
    const responseFrom1C = await forwardRequestToOneC(request.body);

    // 2. Если 1С вернула успешный ответ, работаем с календарем
    if (responseFrom1C.status === 'success') {
      const meetingData = (action === 'saveNewMeeting') ? responseFrom1C.data : payload.newData;
      handleCalendarEvent(action, meetingData);
    }

    // 3. Возвращаем ответ от 1С на фронтенд
    response.status(200).json(responseFrom1C);

  } catch (error) {
    console.error("Proxy error:", error.message);
    response.status(500).json({ status: 'error', message: 'Ошибка при обращении к серверу 1С' });
  }
}

// --- ФУНКЦИЯ ДЛЯ РАБОТЫ С 1С ---
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

// --- ФУНКЦИИ ДЛЯ РАБОТЫ С GOOGLE CALENDAR ---

// Создает авторизованный клиент для работы с API
function getGoogleAuth(userEmail) {
  // Ключи берутся из переменных окружения Vercel
  const auth = new google.auth.JWT({
    email: process.env.GAPI_CLIENT_EMAIL,
    key: process.env.GAPI_PRIVATE_KEY.replace(/\\n/g, '\n'), // Важная обработка ключа
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: userEmail, // Указываем, от чьего имени действуем
  });
  return auth;
}

// Главная функция управления событиями календаря
async function handleCalendarEvent(action, meeting) {
  // Выполняем действия только для сохранения или обновления встреч
  if (!meeting || !meeting.ManagerLogin || (action !== 'saveNewMeeting' && action !== 'updateMeeting')) {
    return;
  }

  const auth = getGoogleAuth(meeting.ManagerLogin);
  const calendar = google.calendar({ version: 'v3', auth });

  const isCancelled = (meeting.Status === 'Отмена' || meeting.Status === 'Завершена');

  // Если встреча отменена и у нее есть ID события в календаре, удаляем его
  if (isCancelled && meeting.calendarEventId) {
    try {
      await calendar.events.delete({ auth, calendarId: 'primary', eventId: meeting.calendarEventId });
    } catch (e) { console.error(`Не удалось удалить событие ${meeting.calendarEventId}:`, e.message); }
    return;
  }

  if (isCancelled) return; // Если отменена, но ID нет, просто выходим

  // Готовим данные для события
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
      // Обновляем существующее событие
      await calendar.events.update({ auth, calendarId: 'primary', eventId: meeting.calendarEventId, resource: eventResource });
    } else {
      // Создаем новое событие
      const newEvent = await calendar.events.insert({ auth, calendarId: 'primary', resource: eventResource });
      // Отправляем ID нового события обратно в 1С
      const payloadTo1C = { action: "updateMeetingCalendarId", payload: { meetingId: meeting.ID, calendarEventId: newEvent.data.id } };
      forwardRequestToOneC(JSON.stringify(payloadTo1C));
    }
  } catch (e) {
    console.error('Ошибка при работе с Google Calendar API:', e.message);
  }
}

// Вспомогательная функция для парсинга даты
function parseDateTime(dateStr, timeStr) {
  const [day, month, year] = dateStr.split('.');
  const [hours, minutes] = timeStr.split(':');
  const startTime = new Date(year, month - 1, day, hours, minutes);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  return [startTime, endTime];
}
