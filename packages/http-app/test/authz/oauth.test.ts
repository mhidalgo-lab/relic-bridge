// SPDX-License-Identifier: Apache-2.0
// The OAuth integration suite (P5-01) on this project's authz host: the HTTP app on memory storage here, the Worker on
// local D1 under the Workers pool (`apps/worker/test/authz-setup.ts`). The CLI project runs it on SQLite.
import { oauthSuite } from './oauth-suite.ts';

oauthSuite();
