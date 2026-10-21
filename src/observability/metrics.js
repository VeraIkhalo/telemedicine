const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'PostgreSQL query latency',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

const bookings = new client.Counter({
  name: 'bookings_total',
  help: 'Booking attempts by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

const jobsProcessed = new client.Counter({
  name: 'jobs_processed_total',
  help: 'Background jobs by type and outcome',
  labelNames: ['type', 'outcome'],
  registers: [register],
});

const cacheHits = new client.Counter({
  name: 'cache_requests_total',
  help: 'Cache lookups by result',
  labelNames: ['result'],
  registers: [register],
});

function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

module.exports = { register, metricsMiddleware, httpDuration, dbQueryDuration, bookings, jobsProcessed, cacheHits };
