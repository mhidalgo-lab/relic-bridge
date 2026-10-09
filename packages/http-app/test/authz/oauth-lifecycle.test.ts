// SPDX-License-Identifier: Apache-2.0
// The OAuth token lifecycle suite (P5-05) on this project's authz host: the HTTP app on memory storage here, the Worker
// on local D1 under the Workers pool. The CLI project runs it on SQLite.
import { oauthLifecycleSuite } from './oauth-lifecycle-suite.ts';

oauthLifecycleSuite();
