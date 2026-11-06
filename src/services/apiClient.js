import axios from 'axios';
import { logger } from '../logger.js';

// Shared base URL for the internal AR/payments API family
const API_BASE_URL = process.env.VITE_API_BASE_URL || process.env.API_BASE_URL || '';

/** Plain axios instance */

// production

export const axiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: Number(process.env.API_REQUEST_TIMEOUT_MS) || 30000,
});

// development


export function assertApiBaseUrlConfigured() {
  if (!API_BASE_URL) {
    const message = 'VITE_API_BASE_URL / API_BASE_URL is not configured';
    logger.error(message);
    throw new Error(message);
  }
}

// Separate base URL for the subjects/PSD automation API family
const SUBJECT_API_BASE_URL = process.env.VITE_Subject_BASE_URL || process.env.SUBJECT_API_BASE_URL || '';

export const subjectAxiosInstance = axios.create({
  baseURL: SUBJECT_API_BASE_URL,
  timeout: Number(process.env.API_REQUEST_TIMEOUT_MS) || 30000,
});

