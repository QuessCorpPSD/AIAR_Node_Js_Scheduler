import { axiosInstance, assertApiBaseUrlConfigured } from './apiClient.js';
import { logger } from '../logger.js';

// Ported from the frontend's handleAutoSubmit/getAuthToken
const LOGIN_ENDPOINT = process.env.AR_LOGIN_ENDPOINT || 'Authendicate/UserLogin';

let authToken = null;

// If several calls need a token at once
let loginPromise = null;

function getCredentials() {
  const username = process.env.AR_API_USERNAME;
  const password = process.env.AR_API_PASSWORD;
  if (!username || !password) {
    logger.error('AR_API_USERNAME / AR_API_PASSWORD are not configured');
    throw new Error('AR_API_USERNAME / AR_API_PASSWORD are not configured');
  }
  return { username, password };
}

async function login() {
  assertApiBaseUrlConfigured();
  const { username, password } = getCredentials();

  const payload = {
    username,
    password,
    ipAddress: '',
    Cname: '',
  };

  const loginResponse = await axiosInstance.post(LOGIN_ENDPOINT, payload);
  const token = loginResponse.data?.Data?.token;

  if (!token) {
    const reason = loginResponse.data?.Data?.error_Message || 'no token in response';
    logger.error('AR API login failed: Token is empty. Response data:', { reason });
    throw new Error(`Login failed: ${reason}`);
  }

  logger.info('AR API login succeeded');
  authToken = token;
  return token;
}

/** Returns the cached bearer token */
export async function getAuthToken() {
  if (authToken) return authToken;

  if (!loginPromise) {
    loginPromise = login().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

/** Clears the cached token so the next getAuthToken() call logs in again */
export function clearAuthToken() {
  authToken = null;
}
