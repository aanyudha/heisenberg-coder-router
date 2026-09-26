import { createContext, useContext } from 'react';
import type {
  CompanionStatus,
  RecentTraffic,
  RoutingVerify,
  StatusResponse,
  TelemetryLike,
  TelemetryLive,
  WebHandoffSummary,
} from './types';

export interface HcrState {
  online: boolean;
  loading: boolean;
  error: string | null;
  status: StatusResponse | null;
  telemetry: TelemetryLike | null;
  live: TelemetryLive | null;
  verify: RoutingVerify | null;
  companion: CompanionStatus | null;
  handoffs: WebHandoffSummary[];
  recent: RecentTraffic[];
  refresh: () => Promise<void>;
}

export const HcrContext = createContext<HcrState | null>(null);

export function useHcr(): HcrState {
  const value = useContext(HcrContext);
  if (!value) throw new Error('useHcr must be used inside the HCR provider');
  return value;
}
