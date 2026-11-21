// Synthetic, user-initiated Google Drive smoke test. No private metadata or tokens.
export const SMOKE_MARKER = 'RHEA_DRIVE_SMOKE_OK';

export function createDriveSmokeFile(date = new Date(), FileType = File) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('A valid Date is required.');
  }
  const timestamp = date.toISOString();
  const filename = 'rhea-smoke-' + timestamp.replace(/[:.]/g, '-') + '.txt';
  const contents = [
    'RHEA | Google Drive smoke test',
    SMOKE_MARKER,
    'Generated at: ' + timestamp,
    'This synthetic file verifies Google Drive upload, persistence and retrieval.',
    'It contains no personal files or credentials.',
    '',
  ].join('\n');
  return new FileType([contents], filename, { type: 'text/plain' });
}
