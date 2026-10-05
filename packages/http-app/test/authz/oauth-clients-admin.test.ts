// SPDX-License-Identifier: Apache-2.0
// The OAuth clients suite (P5-08) on this project's authz host: the HTTP app on memory storage here, the Worker on
// local D1 under the Workers pool. The CLI project runs it on SQLite.
import { oauthClientsSuite } from './oauth-clients-suite.ts';

oauthClientsSuite();
