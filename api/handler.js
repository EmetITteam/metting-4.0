const axios = require('axios');

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Only POST requests allowed' });
  }

  const ONEC_API_URL = process.env.ONEC_API_URL;
  const ONEC_LOGIN = process.env.ONEC_LOGIN;
  const ONEC_PASSWORD = process.env.ONEC_PASSWORD;

  const headers = { 'Content-Type': 'application/json' };
  if (ONEC_LOGIN && ONEC_PASSWORD) {
    const token = Buffer.from(`${ONEC_LOGIN}:${ONEC_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }

  try {
    const apiResponse = await axios.post(ONEC_API_URL, request.body, { headers });
    response.status(200).json(apiResponse.data);
  } catch (error) {
    console.error("Proxy error:", error.message);
    response.status(500).json({ status: 'error', message: 'Ошибка при обращении к серверу 1С' });
  }
}
