import { axiosInstance } from './apiClient.js';
import { getAuthToken, clearAuthToken } from './authService.js';
import { logger } from '../logger.js';

/** POSTs to `path` with a bearer token attached */
export async function postWithAuth(path, payload, { _isRetry = false, timeout } = {}) {
  const token = await getAuthToken();

  try {
    const response = await axiosInstance.post(path, payload, {
      headers: { Authorization: `Bearer ${token}` },
      ...(timeout ? { timeout } : {}),
    });
    logger.info(`POST ${path} succeeded`, { status: response.status, data: response.data });
    return response.data;
  } catch (error) {
    const status = error?.response?.status;

    if ((status === 401 || status === 403) && !_isRetry) {
      logger.warn(`Auth error (${status}) on ${path} — clearing token and retrying once`);
      clearAuthToken();
      return postWithAuth(path, payload, { _isRetry: true, timeout });
    }
    logger.error(`POST ${path} failed`, { status, error: error.message });

    throw error;
  }
}
