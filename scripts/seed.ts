import './_env.ts';
import { seedSettings } from '../src/lib/server/settings.ts';
import { closePools } from '../src/lib/server/db/index.ts';

/** Idempotent post-migrate seeding of default settings rows. */
await seedSettings();
console.log('✓ settings seeded');
await closePools();
