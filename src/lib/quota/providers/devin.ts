import { apiCall, assertOk } from '../apiCall';
import { authIndexOfFile } from '../files';
import { asRecord } from '../parse';
import { genericPlan } from '../plans';
import type { AuthFileItem, QuotaData, QuotaWindow } from '../types';

/** Devin (Codeium seat management) daily/weekly quota; values are already REMAINING percentages. */

const DEVIN_STATUS_URL = 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus';

const parsePercent = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const percent = Number(value);
  return percent >= 0 && percent <= 100 ? percent : null;
};

const parseUnixSeconds = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
};

export function readDevinQuotaResponse(payload: unknown): QuotaData {
  let parsed = payload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const status = asRecord(asRecord(asRecord(parsed).userStatus).planStatus);
  const planInfo = asRecord(status.planInfo);
  const windows: QuotaWindow[] = (['daily', 'weekly'] as const).map((id) => {
    const remaining = parsePercent(status[`${id}QuotaRemainingPercent`]);
    return {
      id,
      label: id === 'daily' ? 'Daily remaining' : 'Weekly remaining',
      remainingPercent: remaining,
      usedPercent: remaining === null ? null : 100 - remaining,
      resetAtMs: parseUnixSeconds(status[`${id}QuotaResetAtUnix`]),
      periodHours: id === 'daily' ? 24 : 168,
      kind: 'quota',
    };
  });
  return {
    windows: windows.filter((w) => w.remainingPercent !== null || w.resetAtMs !== null),
    plan: genericPlan(typeof planInfo.planName === 'string' ? planInfo.planName : null),
  };
}

export async function fetchDevinQuota(file: AuthFileItem, signal?: AbortSignal): Promise<QuotaData> {
  const authIndex = authIndexOfFile(file);
  if (!authIndex) throw new Error('Auth file missing auth_index');
  const result = await apiCall(
    {
      authIndex,
      method: 'POST',
      url: DEVIN_STATUS_URL,
      header: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      // CPA substitutes $TOKEN$ inside the JSON body as well as in headers.
      data: JSON.stringify({
        metadata: {
          ideName: 'chisel',
          ideVersion: '3000.10.21',
          apiKey: '$TOKEN$',
          locale: 'en',
          os: 'darwin',
          extensionVersion: '3000.10.21',
          clientName: 'chisel',
        },
      }),
    },
    { signal },
  );
  assertOk(result);
  const quota = readDevinQuotaResponse(result.body);
  if (quota.windows.length === 0) throw new Error('No quota data available');
  return quota;
}
