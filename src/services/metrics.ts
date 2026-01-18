import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

// Create registry
export const register = new Registry();

// Collect default metrics (CPU, memory, event loop lag, etc.)
collectDefaultMetrics({ register });

// Custom metrics
export const settlementCounter = new Counter({
  name: "facilitator_settlements_total",
  help: "Total number of settlements processed",
  labelNames: ["network", "status"],
  registers: [register],
});

export const registrationCounter = new Counter({
  name: "facilitator_registrations_total",
  help: "Total number of agent registrations",
  labelNames: ["network", "status"],
  registers: [register],
});

export const feedbackCounter = new Counter({
  name: "facilitator_feedback_total",
  help: "Total number of feedback auth generated",
  labelNames: ["network", "status"],
  registers: [register],
});

export const settlementDuration = new Histogram({
  name: "facilitator_settlement_duration_seconds",
  help: "Settlement processing duration in seconds",
  labelNames: ["network"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const verifyCounter = new Counter({
  name: "facilitator_verify_total",
  help: "Total number of payment verifications",
  labelNames: ["status"],
  registers: [register],
});

export const verifyDuration = new Histogram({
  name: "facilitator_verify_duration_seconds",
  help: "Verification duration in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

