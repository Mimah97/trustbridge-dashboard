import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Rate-limit burst coverage for /api/check under Wave load.
//
// This scenario intentionally drives a burst above the configured limit so the
// operator-facing behavior (429 + rate-limit headers) is exercised the same way
// production Wave load tests do. Keep the thresholds in sync with
// src/lib/rate-limit.ts and the assertions in tests/.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CHECK_PATH = __ENV.CHECK_PATH || '/api/check';
const BURST_VUS = Number(__ENV.BURST_VUS || 20);
const BURST_ITERATIONS = Number(__ENV.BURST_ITERATIONS || 5);

const rateLimited = new Rate('rate_limited_responses');
const allowed = new Rate('allowed_responses');
const headerPresent = new Rate('rate_limit_headers_present');

export const options = {
  scenarios: {
    // Steady happy path: requests under the limit should succeed.
    steady: {
      executor: 'constant-vus',
      vus: 2,
      duration: '10s',
      exec: 'steadyCheck',
    },
    // Burst: many VUs fire at once to exceed the limit and observe 429s.
    burst: {
      executor: 'per-vu-iterations',
      vus: BURST_VUS,
      iterations: BURST_ITERATIONS,
      maxDuration: '30s',
      startTime: '12s',
      exec: 'burstCheck',
    },
  },
  thresholds: {
    // Happy path must stay healthy.
    'http_req_failed{scenario:steady}': ['rate<0.01'],
    'allowed_responses{scenario:steady}': ['rate>0.99'],
    // Burst must actually trigger the limiter and always carry headers.
    'rate_limited_responses{scenario:burst}': ['rate>0'],
    'rate_limit_headers_present': ['rate>0.99'],
  },
};

function checkPayload() {
  return JSON.stringify({
    contributor: `wave-load-${__VU}-${__ITER}`,
    amount: 100,
  });
}

function params() {
  return {
    headers: {
      'Content-Type': 'application/json',
      // CSRF token is expected by the API; supply via env in CI.
      'x-csrf-token': __ENV.CSRF_TOKEN || 'wave-load-token',
    },
    tags: { endpoint: 'check' },
  };
}

function assertRateLimitHeaders(res) {
  const limit = res.headers['X-RateLimit-Limit'] || res.headers['Ratelimit-Limit'];
  const remaining = res.headers['X-RateLimit-Remaining'] || res.headers['Ratelimit-Remaining'];
  const reset = res.headers['X-RateLimit-Reset'] || res.headers['Ratelimit-Reset'];
  const retryAfter = res.headers['Retry-After'];

  const hasCore = Boolean(limit && remaining && reset);
  headerPresent.add(hasCore);

  check(res, {
    'rate-limit headers present': () => hasCore,
    'remaining is numeric': () => remaining === undefined || !Number.isNaN(Number(remaining)),
  });

  if (res.status === 429) {
    check(res, {
      '429 includes Retry-After': () => Boolean(retryAfter),
      '429 remaining is zero': () => Number(remaining) === 0,
    });
  }
}

export function steadyCheck() {
  const res = http.post(`${BASE_URL}${CHECK_PATH}`, checkPayload(), params());
  allowed.add(res.status >= 200 && res.status < 300);
  check(res, {
    'steady check succeeds': (r) => r.status >= 200 && r.status < 300,
  });
  assertRateLimitHeaders(res);
  sleep(1);
}

export function burstCheck() {
  const res = http.post(`${BASE_URL}${CHECK_PATH}`, checkPayload(), params());
  rateLimited.add(res.status === 429);
  check(res, {
    'burst returns allowed or rate limited': (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 429,
  });
  assertRateLimitHeaders(res);
}
