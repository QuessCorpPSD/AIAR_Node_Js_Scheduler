import { subjectAxiosInstance } from './apiClient.js';
import { logger } from '../logger.js';

// No auth needed for this endpoint
const SKIPPED_SUBJECTS_PATH = process.env.SKIPPED_SUBJECTS_PATH || '';

// Used if the API call fails, so a transient outage doesn't disable subject skipping entirely
const FALLBACK_SKIPPED_SUBJECT_KEYWORDS = ['misc fee','Monthly Attendance and Monthly Allowances of','DMART Attendance Consolidation File RPA'];
/** Fetches the list of subject keywords to skip from the external API */
export async function getSkippedSubjectKeywords() {
  try {
    const response = await subjectAxiosInstance.get(SKIPPED_SUBJECTS_PATH);
    const body = response.data;

    if (body?.StatusCode !== 200 || body?.Error) {
      logger.warn('Skipped-subjects API returned an error response — using fallback list', {
        path: SKIPPED_SUBJECTS_PATH || '(base URL)',
        statusCode: body?.StatusCode,
        error: body?.Error
      });
      return FALLBACK_SKIPPED_SUBJECT_KEYWORDS;
    }

    const rows = body?.Data?.Table;

    if (!Array.isArray(rows)) {
      logger.warn('Skipped-subjects API response missing Data.Table array — using fallback list', {
        path: SKIPPED_SUBJECTS_PATH || '(base URL)',
        received: body
      });
      return FALLBACK_SKIPPED_SUBJECT_KEYWORDS;
    }

    const keywords = rows
      .map((row) => (row?.SubjectLine || '').trim())
      .filter(Boolean);

    logger.info(`Fetched ${keywords.length} skipped-subject keyword(s) from API`, { keywords });
    return keywords;
  } catch (err) {
    logger.warn('Failed to fetch skipped-subject keywords from API — using fallback list', {
      path: SKIPPED_SUBJECTS_PATH || '(base URL)',
      error: err.message
    });
    return FALLBACK_SKIPPED_SUBJECT_KEYWORDS;
  }
}
