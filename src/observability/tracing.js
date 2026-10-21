// OpenTelemetry tracing. Loaded with `node -r` so instrumentation patches http/express/pg first.
// Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://jaeger:4318).
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'amrutam-api',
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
}
