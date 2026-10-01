import axios, { AxiosInstance } from 'axios';
import { env, requireEnv } from '../../pipeline/config/env';
import { TestDataFactory } from './types';

export interface BookingDates {
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
}

/**
 * The real live response shape, confirmed by direct API calls against automationintesting.online
 * - flat, not the nested {bookingid, booking: {...}} shape the platform's own Java model
 * (CreatedBooking.java) suggests. The deployed API and its published source have drifted; this
 * was built against the former, not assumed from the latter.
 */
export interface Booking {
  bookingid: number;
  roomid: number;
  firstname: string;
  lastname: string;
  depositpaid: boolean;
  bookingdates: BookingDates;
  email?: string;
  phone?: string;
}

// Confirmed live via GET /api/room (public, no auth): seeded rooms are ids 1-3 (101 Single, 102
// Double, 103 Suite). Exported so the E2E UI test can translate a created booking's roomid into
// the room type name shown on the homepage, without re-deriving it itself.
export const SEEDED_ROOM_TYPES: Record<number, string> = { 1: 'Single', 2: 'Double', 3: 'Suite' };
const SEEDED_ROOM_IDS = Object.keys(SEEDED_ROOM_TYPES).map(Number);

function randomTag(): string {
  return Math.random().toString(16).slice(2, 10);
}

/**
 * Spread far into the future and randomized. This is a shared public practice instance - real
 * traffic from other users was observed live during investigation (pre-existing bookings not
 * created by this factory), and a same-room/overlapping-date conflict is a real 409 (confirmed
 * live), so keeping the range wide and random keeps collision risk with that traffic low.
 */
function randomFutureDates(): BookingDates {
  const startOffsetDays = 300 + Math.floor(Math.random() * 400);
  const checkin = new Date(Date.now() + startOffsetDays * 24 * 60 * 60 * 1000);
  const checkout = new Date(checkin.getTime() + 24 * 60 * 60 * 1000);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { checkin: toIso(checkin), checkout: toIso(checkout) };
}

/**
 * TestDataFactory<Booking> against the real, live Restful-Booker-Platform API - the first
 * concrete per-app implementation of the generic contract in src/testData/types.ts. A template
 * for the next app's factory, not something to generalize further (see README's Test Data via API
 * section for why).
 */
export class RestfulBookerBookingFactory implements TestDataFactory<Booking> {
  readonly entityName = 'booking';

  private http: AxiosInstance;
  private tokenPromise: Promise<string> | null = null;

  constructor(baseUrl: string = env.RBP_API_BASE_URL) {
    this.http = axios.create({ baseURL: baseUrl, headers: { 'Content-Type': 'application/json' } });
  }

  private async getToken(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const username = requireEnv('RBP_AUTH_USERNAME', 'test-data booking factory');
        const password = requireEnv('RBP_AUTH_PASSWORD', 'test-data booking factory');
        // The live API returns the token in the JSON body, not a Set-Cookie header (confirmed
        // live - this differs from the platform's own Java source, which sets a cookie). The
        // caller is responsible for attaching it as a Cookie header on subsequent requests.
        const { data } = await this.http.post<{ token: string }>('/auth/login', { username, password });
        return data.token;
      })();
    }
    return this.tokenPromise;
  }

  /**
   * Unauthenticated by design - the live API allows anonymous booking creation (confirmed against
   * the real endpoint: no auth failure without a token), matching real guest-checkout behavior.
   * `firstname` carries a TEST- tag so an orphaned record (if a specific cleanup() call ever
   * fails) is identifiable and safe to hand-delete later.
   */
  async create(overrides: Partial<Booking> = {}): Promise<Booking> {
    const { bookingid: _ignoredBookingId, ...rest } = overrides;
    const body = {
      roomid: SEEDED_ROOM_IDS[Math.floor(Math.random() * SEEDED_ROOM_IDS.length)],
      firstname: `TEST-${randomTag()}`,
      lastname: 'AutomatedTestData',
      depositpaid: true,
      bookingdates: randomFutureDates(),
      ...rest,
    };
    const { data } = await this.http.post<Booking>('/booking', body);
    return data;
  }

  async cleanup(entity: Booking): Promise<void> {
    const token = await this.getToken();
    await this.http.delete(`/booking/${entity.bookingid}`, { headers: { Cookie: `token=${token}` } });
  }
}

export const bookingFactory = new RestfulBookerBookingFactory();
