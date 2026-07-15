/*
 * Copyright 2026 Scalar Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.scalar.re.configtool.service;

import com.scalar.db.api.TableMetadata;
import com.scalar.db.io.DataType;

/**
 * Physical schema of the RE management tables (TableMetadata for
 * {@code DistributedTransactionAdmin.createTable}).
 *
 * <p>The source of truth is the ScalarRE core product's {@code SchemaInitializer}. This class
 * is a <b>provisional duplicate</b> that reproduces a frozen snapshot (2026-06-19) of that
 * schema in Java. Column order and PK/CK order must match the snapshot exactly.
 *
 * <p>Note: RE core/SDK/ConfigTool are eventually expected to be consolidated into a single
 * repository, at which point this duplicate will be merged into a shared module. Until then,
 * whenever the RE core schema changes, the snapshot doc and this class must be updated to
 * follow (the unit of drift management).
 */
public final class ReSchema {

    private ReSchema() {}

    // Table names (RE ReTableNames)
    public static final String NODE_HEARTBEAT = "re_node_heartbeat";
    public static final String RE_COMPLETED = "re_completed";
    public static final String RE_QUEUE = "re_queue";
    public static final String RE_SUBSCRIPTION = "re_subscription";
    public static final String OUTBOX = "re_outbox";
    public static final String INBOX = "re_inbox";
    public static final String HOLD = "re_hold";

    /** Column that consensus-commit automatically adds to transaction-managed tables. Indexed for health checks. */
    public static final String TX_STATE = "tx_state";

    /** re_node_heartbeat. */
    public static TableMetadata nodeHeartbeat() {
        return TableMetadata.newBuilder()
                .addColumn("cluster_id", DataType.TEXT)
                .addColumn("node_ip", DataType.TEXT)
                .addColumn("heartbeat_at", DataType.BIGINT)
                .addPartitionKey("cluster_id")
                .addClusteringKey("node_ip")
                .build();
    }

    /** re_completed — per-transaction delivery ledger. */
    public static TableMetadata reCompleted() {
        return TableMetadata.newBuilder()
                .addColumn("event_type", DataType.TEXT)
                .addColumn("event_id", DataType.TEXT)
                .addColumn("partition", DataType.BIGINT)
                .addColumn("step_id", DataType.INT)
                .addColumn("target", DataType.TEXT)
                .addColumn("body", DataType.TEXT)
                .addColumn("completed_at", DataType.BIGINT)
                .addColumn("ttl", DataType.BIGINT)
                .addPartitionKey("event_type")
                .addClusteringKey("event_id")
                .addClusteringKey("partition")
                .addClusteringKey("step_id")
                .addClusteringKey("target")
                .build();
    }

    /** re_queue — one merged row per (event_id, destination). */
    public static TableMetadata reQueue() {
        return TableMetadata.newBuilder()
                .addColumn("event_type", DataType.TEXT)
                .addColumn("destination", DataType.TEXT)
                .addColumn("partition", DataType.BIGINT)
                .addColumn("event_id", DataType.TEXT)
                .addColumn("body", DataType.TEXT)
                .addColumn("created_at", DataType.BIGINT)
                .addPartitionKey("event_type")
                .addClusteringKey("destination")
                .addClusteringKey("partition")
                .addClusteringKey("event_id")
                .build();
    }

    /** re_subscription. */
    public static TableMetadata reSubscription() {
        return TableMetadata.newBuilder()
                .addColumn("event_type", DataType.TEXT)
                .addColumn("destination", DataType.TEXT)
                .addColumn("partition_count", DataType.INT)
                .addPartitionKey("event_type")
                .addClusteringKey("destination")
                .build();
    }

    /** re_outbox. */
    public static TableMetadata outbox() {
        return TableMetadata.newBuilder()
                .addColumn("event_type", DataType.TEXT)
                .addColumn("event_id", DataType.TEXT)
                .addColumn("body", DataType.TEXT)
                .addColumn("created_at", DataType.BIGINT)
                .addPartitionKey("event_type")
                .addClusteringKey("event_id")
                .build();
    }

    /** re_inbox. */
    public static TableMetadata inbox() {
        return TableMetadata.newBuilder()
                .addColumn("event_type", DataType.TEXT)
                .addColumn("partition", DataType.BIGINT)
                .addColumn("event_id", DataType.TEXT)
                .addColumn("step_id", DataType.INT)
                .addColumn("seq", DataType.INT)
                .addColumn("body", DataType.TEXT)
                .addColumn("delivered_at", DataType.BIGINT)
                .addColumn("status", DataType.INT)
                .addColumn("ack_required", DataType.BOOLEAN)
                .addPartitionKey("event_type")
                .addClusteringKey("partition")
                .addClusteringKey("event_id")
                .addClusteringKey("step_id")
                .addClusteringKey("seq")
                .build();
    }

    /** re_hold. */
    public static TableMetadata hold() {
        return TableMetadata.newBuilder()
                .addColumn("tracking_type", DataType.TEXT)
                .addColumn("event_type", DataType.TEXT)
                .addColumn("event_id", DataType.TEXT)
                .addColumn("body", DataType.TEXT)
                .addColumn("created_at", DataType.BIGINT)
                .addPartitionKey("tracking_type")
                .addPartitionKey("event_type")
                .addClusteringKey("event_id")
                .build();
    }
}
