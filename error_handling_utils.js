// Utility functions for error handling, rate limiting, circuit breaking, and performance monitoring.

/**
 * Centralized error logger with different log levels and persistence.
 */
class ErrorLogger {
    constructor() {
        this.logLevel = 'INFO'; // Configurable: DEBUG, INFO, WARN, ERROR
        this.maxLogs = 100; // Maximum number of logs to keep in memory
        this.logs = [];
    }

    /**
     * Sets the minimum logging level.
     * @param {string} level - The new log level (e.g., 'DEBUG', 'INFO').
     */
    setLogLevel(level) {
        this.logLevel = level;
    }

    /**
     * Logs a message with a specified level.
     * @param {string} level - The log level (e.g., 'INFO', 'ERROR').
     * @param {string} message - The log message.
     * @param {any} [data=null] - Optional additional data to log.
     */
    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            data,
            stack: new Error().stack
        };

        this.logs.push(logEntry);
        
        // Maintain a fixed number of logs to prevent excessive memory usage.
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }

        // Output to console based on the configured log level.
        const shouldLog = this.shouldLog(level);
        if (shouldLog) {
            const consoleMethod = this.getConsoleMethod(level);
            consoleMethod(`[${timestamp}] ${level}: ${message}`, data || '');
        }

        // Persist logs to Chrome storage for later retrieval.
        this.persistLogs();
    }

    /**
     * Determines if a log message should be output based on the current log level.
     * @param {string} level - The level of the message to check.
     * @returns {boolean} - True if the message should be logged, false otherwise.
     */
    shouldLog(level) {
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);
        return messageLevelIndex >= currentLevelIndex;
    }

    /**
     * Returns the appropriate console method for a given log level.
     * @param {string} level - The log level.
     * @returns {function} - The console method (e.g., console.info, console.error).
     */
    getConsoleMethod(level) {
        switch (level) {
            case 'DEBUG': return console.debug;
            case 'INFO': return console.info;
            case 'WARN': return console.warn;
            case 'ERROR': return console.error;
            default: return console.log;
        }
    }

    /**
     * Persists a subset of logs to Chrome local storage.
     */
    async persistLogs() {
        try {
            // Only keep the most recent 50 logs for storage to limit storage usage.
            const logsToStore = this.logs.slice(-50);
            await chrome.storage.local.set({ 
                errorLogs: logsToStore,
                lastLogUpdate: Date.now()
            });
        } catch (error) {
            console.warn('Could not persist logs to storage:', error);
        }
    }

    /**
     * Retrieves stored logs from Chrome local storage.
     * @returns {Promise<Array>} - A promise that resolves to an array of log entries.
     */
    async getLogs() {
        try {
            const result = await chrome.storage.local.get(['errorLogs']);
            return result.errorLogs || [];
        } catch (error) {
            console.warn('Could not retrieve logs from storage:', error);
            return this.logs;
        }
    }

    /**
     * Logs a debug message.
     * @param {string} message - The debug message.
     * @param {any} [data] - Optional additional data.
     */
    debug(message, data) { this.log('DEBUG', message, data); }
    /**
     * Logs an info message.
     * @param {string} message - The info message.
     * @param {any} [data] - Optional additional data.
     */
    info(message, data) { this.log('INFO', message, data); }
    /**
     * Logs a warning message.
     * @param {string} message - The warning message.
     * @param {any} [data] - Optional additional data.
     */
    warn(message, data) { this.log('WARN', message, data); }
    /**
     * Logs an error message.
     * @param {string} message - The error message.
     * @param {any} [data] - Optional additional data.
     */
    error(message, data) { this.log('ERROR', message, data); }
}

/**
 * Implements a rate limiter to control the frequency of requests to external services.
 */
class RateLimiter {
    constructor() {
        this.requests = new Map(); // Stores timestamps of requests for each provider
        this.limits = {
            chatgpt: { requests: 60, window: 60000 }, // 60 requests per minute
            gemini: { requests: 60, window: 60000 },
            deepseek: { requests: 50, window: 60000 },
            claude: { requests: 50, window: 60000 }
        };
        // Default limit for unknown providers
        this.defaultLimit = { requests: 50, window: 60000 };
    }

    /**
     * Checks if a request can be made for a given provider based on rate limits.
     * @param {string} provider - The service provider (e.g., 'chatgpt').
     * @returns {{allowed: boolean, resetTime: number|null, remainingTime?: number}} - Status of the request.
     */
    canMakeRequest(provider) {
        const now = Date.now();
        const limit = this.limits[provider] || this.defaultLimit;
        
        if (!limit) {
            return { allowed: true, resetTime: null }; // No limit defined, allow request.
        }

        if (!this.requests.has(provider)) {
            this.requests.set(provider, []);
        }

        const requests = this.requests.get(provider);
        
        // Filter out requests that are outside the current time window.
        const validRequests = requests.filter(timestamp => 
            now - timestamp < limit.window
        );
        
        this.requests.set(provider, validRequests);

        // If the number of valid requests exceeds the limit, deny the request.
        if (validRequests.length >= limit.requests) {
            const oldestRequest = Math.min(...validRequests);
            const resetTime = oldestRequest + limit.window;
            return { 
                allowed: false, 
                resetTime,
                remainingTime: resetTime - now
            };
        }

        return { allowed: true, resetTime: null };
    }

    /**
     * Records a successful request for a given provider.
     * @param {string} provider - The service provider.
     */
    recordRequest(provider) {
        const now = Date.now();
        if (!this.requests.has(provider)) {
            this.requests.set(provider, []);
        }
        this.requests.get(provider).push(now);
    }

    /**
     * Gets the number of remaining requests for a provider within the current window.
     * @param {string} provider - The service provider.
     * @returns {number} - The number of remaining requests.
     */
    getRemainingRequests(provider) {
        const limit = this.limits[provider];
        if (!limit) return Infinity;

        const now = Date.now();
        const requests = this.requests.get(provider) || [];
        const validRequests = requests.filter(timestamp => 
            now - timestamp < limit.window
        );

        return Math.max(0, limit.requests - validRequests.length);
    }
}

/**
 * Implements the Circuit Breaker pattern to prevent cascading failures in external service calls.
 */
class CircuitBreaker {
    constructor(provider, options = {}) {
        this.provider = provider;
        this.failureThreshold = options.failureThreshold || 5; // Number of consecutive failures to open the circuit
        this.resetTimeout = options.resetTimeout || 60000; // Time in ms before attempting to close the circuit (HALF_OPEN state)
        this.monitoringPeriod = options.monitoringPeriod || 300000; // Time in ms to consider failures for the threshold
        
        this.state = 'CLOSED'; // Current state: CLOSED, OPEN, HALF_OPEN
        this.failures = []; // Timestamps of recent failures
        this.lastFailureTime = null;
        this.nextAttemptTime = null; // Time when the circuit can transition to HALF_OPEN
    }

    /**
     * Executes a function, applying circuit breaker logic.
     * @param {Function} fn - The function to execute (e.g., an API call).
     * @returns {Promise<any>} - A promise that resolves with the function's result or rejects if the circuit is open.
     */
    async call(fn) {
        if (this.state === 'OPEN') {
            // If the circuit is open, check if the reset timeout has passed.
            if (Date.now() < this.nextAttemptTime) {
                throw new Error(`Circuit breaker is OPEN for ${this.provider}. Next attempt at ${new Date(this.nextAttemptTime).toLocaleTimeString()}`);
            } else {
                // If timeout passed, transition to HALF_OPEN to allow a single test request.
                this.state = 'HALF_OPEN';
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    /**
     * Resets the circuit to CLOSED on successful execution.
     */
    onSuccess() {
        this.failures = [];
        this.state = 'CLOSED';
        this.nextAttemptTime = null;
    }

    /**
     * Records a failure and potentially opens the circuit.
     */
    onFailure() {
        const now = Date.now();
        this.failures.push(now);
        this.lastFailureTime = now;

        // Remove failures that are outside the monitoring period.
        this.failures = this.failures.filter(timestamp => 
            now - timestamp < this.monitoringPeriod
        );

        // If failure threshold is met, open the circuit.
        if (this.failures.length >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttemptTime = now + this.resetTimeout;
        }
    }

    /**
     * Gets the current state of the circuit breaker.
     * @returns {{state: string, failures: number, nextAttemptTime: number|null, lastFailureTime: number|null}} - The circuit breaker's status.
     */
    getState() {
        return {
            state: this.state,
            failures: this.failures.length,
            nextAttemptTime: this.nextAttemptTime,
            lastFailureTime: this.lastFailureTime
        };
    }
}

/**
 * Monitors the health status of API endpoints.
 */
class HealthChecker {
    constructor() {
        this.healthStatus = new Map();
        this.checkInterval = 300000; // Default health check interval: 5 minutes
        this.timeout = 10000; // Default request timeout: 10 seconds
    }

    /**
     * Performs a health check on a given URL for a provider.
     * @param {string} provider - The service provider.
     * @param {string} url - The URL to check.
     * @param {Object} [headers={}] - Optional headers for the request.
     * @returns {Promise<Object>} - A promise that resolves with the health data.
     */
    async checkHealth(provider, url, headers = {}) {
        const startTime = Date.now();
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                method: 'HEAD', // Use HEAD to minimize data transfer and improve performance.
                headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const responseTime = Date.now() - startTime;
            const isHealthy = response.ok;

            const healthData = {
                provider,
                isHealthy,
                responseTime,
                status: response.status,
                timestamp: new Date().toISOString(),
                lastChecked: Date.now()
            };

            this.healthStatus.set(provider, healthData);
            return healthData;

        } catch (error) {
            const responseTime = Date.now() - startTime;
            const healthData = {
                provider,
                isHealthy: false,
                responseTime,
                error: error.message,
                timestamp: new Date().toISOString(),
                lastChecked: Date.now()
            };

            this.healthStatus.set(provider, healthData);
            return healthData;
        }
    }

    /**
     * Retrieves the last known health status for a provider.
     * @param {string} provider - The service provider.
     * @returns {Object} - The health status data.
     */
    getHealth(provider) {
        return this.healthStatus.get(provider) || {
            provider,
            isHealthy: null,
            lastChecked: null
        };
    }

    /**
     * Retrieves health status for all monitored providers.
     * @returns {Object} - An object containing health data for all providers.
     */
    getAllHealth() {
        return Object.fromEntries(this.healthStatus);
    }

    /**
     * Checks if a provider is currently considered healthy and its status is recent.
     * @param {string} provider - The service provider.
     * @returns {boolean} - True if the provider is healthy and recently checked, false otherwise.
     */
    isProviderHealthy(provider) {
        const health = this.getHealth(provider);
        // Consider a provider healthy if its last check was successful and within a reasonable time frame.
        const isRecent = health.lastChecked && (Date.now() - health.lastChecked < this.checkInterval * 2);
        return health.isHealthy === true && isRecent;
    }
}

/**
 * Provides a utility for retrying asynchronous operations with exponential backoff and jitter.
 */
class RetryUtil {
    /**
     * Retries a given asynchronous function a specified number of times.
     * @param {Function} fn - The asynchronous function to retry.
     * @param {Object} [options={}] - Retry configuration options.
     * @param {number} [options.maxRetries=3] - Maximum number of retry attempts.
     * @param {number} [options.baseDelay=1000] - Base delay in milliseconds before the first retry.
     * @param {number} [options.maxDelay=30000] - Maximum delay in milliseconds between retries.
     * @param {number} [options.backoffFactor=2] - Factor by which the delay increases with each retry.
     * @param {boolean} [options.jitter=true] - Whether to add random jitter to the delay.
     * @param {Function} [options.retryCondition=() => true] - A function to determine if a specific error should trigger a retry.
     * @returns {Promise<any>} - A promise that resolves with the function's result or rejects after all retries fail.
     */
    static async withRetry(fn, options = {}) {
        const {
            maxRetries = 3,
            baseDelay = 1000,
            maxDelay = 30000,
            backoffFactor = 2,
            jitter = true,
            retryCondition = () => true
        } = options;

        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn(attempt);
            } catch (error) {
                lastError = error;

                // Check if the error meets the condition for retrying.
                if (!retryCondition(error, attempt)) {
                    throw error;
                }

                // Do not wait after the final attempt.
                if (attempt === maxRetries) {
                    break;
                }

                // Calculate delay with exponential backoff.
                let delay = Math.min(baseDelay * Math.pow(backoffFactor, attempt - 1), maxDelay);
                
                // Add jitter to prevent all retries from happening at the same time (thundering herd problem).
                if (jitter) {
                    delay = delay * (0.5 + Math.random() * 0.5);
                }

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }
}

/**
 * Monitors and tracks performance metrics for various operations.
 */
class PerformanceMonitor {
    constructor() {
        this.metrics = new Map(); // Stores performance samples for different operations.
        this.maxSamples = 100; // Maximum number of samples to keep per metric.
    }

    /**
     * Starts a timer for a given operation.
     * @param {string} provider - The service provider.
     * @param {string} operation - The name of the operation.
     * @returns {{key: string, startTime: number, provider: string, operation: string}} - The timer object.
     */
    startTimer(provider, operation) {
        const key = `${provider}_${operation}`;
        return {
            key,
            startTime: performance.now(),
            provider,
            operation
        };
    }

    /**
     * Ends a timer and records the duration.
     * @param {{key: string, startTime: number, provider: string, operation: string}} timer - The timer object returned by startTimer.
     * @returns {number} - The duration of the operation in milliseconds.
     */
    endTimer(timer) {
        const endTime = performance.now();
        const duration = endTime - timer.startTime;

        if (!this.metrics.has(timer.key)) {
            this.metrics.set(timer.key, []);
        }

        const samples = this.metrics.get(timer.key);
        samples.push({
            duration,
            timestamp: Date.now()
        });

        // Keep only the most recent samples.
        if (samples.length > this.maxSamples) {
            samples.splice(0, samples.length - this.maxSamples);
        }

        return duration;
    }

    /**
     * Retrieves aggregated performance metrics for a specific operation.
     * @param {string} provider - The service provider.
     * @param {string} operation - The name of the operation.
     * @returns {Object|null} - An object containing performance statistics or null if no samples exist.
     */
    getMetrics(provider, operation) {
        const key = `${provider}_${operation}`;
        const samples = this.metrics.get(key) || [];
        
        if (samples.length === 0) {
            return null;
        }

        const durations = samples.map(s => s.duration);
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const min = Math.min(...durations);
        const max = Math.max(...durations);
        
        // Calculate percentiles for a better understanding of distribution.
        const sorted = durations.sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];

        return {
            provider,
            operation,
            sampleCount: samples.length,
            average: Math.round(avg),
            min: Math.round(min),
            max: Math.round(max),
            p50: Math.round(p50),
            p95: Math.round(p95),
            p99: Math.round(p99)
        };
    }

    /**
     * Retrieves aggregated performance metrics for all monitored operations.
     * @returns {Object} - An object containing performance statistics grouped by provider and operation.
     */
    getAllMetrics() {
        const result = {};
        for (const [key, samples] of this.metrics) {
            const [provider, operation] = key.split('_');
            const metrics = this.getMetrics(provider, operation);
            if (metrics) {
                if (!result[provider]) result[provider] = {};
                result[provider][operation] = metrics;
            }
        }
        return result;
    }
}

// Global instances of the utility classes for easy access throughout the extension.
const logger = new ErrorLogger();
const rateLimiter = new RateLimiter();
const healthChecker = new HealthChecker();
const performanceMonitor = new PerformanceMonitor();

// Circuit breakers for each supported AI provider to manage their API health.
// Uses a Proxy to lazily create circuit breakers for any provider on demand.
const circuitBreakers = new Proxy({}, {
    get(target, prop) {
        if (typeof prop === 'string' && !target[prop]) {
            target[prop] = new CircuitBreaker(prop);
        }
        return target[prop];
    }
});

// Pre-initialize built-in providers
circuitBreakers.chatgpt = new CircuitBreaker('chatgpt');
circuitBreakers.gemini = new CircuitBreaker('gemini');
circuitBreakers.deepseek = new CircuitBreaker('deepseek');
circuitBreakers.claude = new CircuitBreaker('claude');

// Export modules for Node.js environment (e.g., for testing).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ErrorLogger,
        RateLimiter,
        CircuitBreaker,
        HealthChecker,
        RetryUtil,
        PerformanceMonitor,
        logger,
        rateLimiter,
        healthChecker,
        performanceMonitor,
        circuitBreakers
    };
}

// Expose utilities globally in the browser environment for direct access.
if (typeof window !== 'undefined') {
    window.ErrorHandlingUtils = {
        ErrorLogger,
        RateLimiter,
        CircuitBreaker,
        HealthChecker,
        RetryUtil,
        PerformanceMonitor,
        logger,
        rateLimiter,
        healthChecker,
        performanceMonitor,
        circuitBreakers
    };
}