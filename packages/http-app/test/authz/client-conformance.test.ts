// SPDX-License-Identifier: Apache-2.0
// The client conformance suite (P5-06) on this project's authz host: the HTTP app on memory storage here, the Worker on
// local D1 under the Workers pool. The CLI project runs it on SQLite.
import { clientConformanceSuite } from './client-conformance-suite.ts';

clientConformanceSuite();
