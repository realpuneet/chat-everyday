// Runs in every test worker before test files import application code (config reads env at import).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/chat_everyday_test';
process.env.LOG_LEVEL = 'silent';
process.env.DISABLE_SWEEPER = 'true';
process.env.LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || './.data/test-uploads';
process.env.RATE_LIMIT_MULTIPLIER = '1000';
