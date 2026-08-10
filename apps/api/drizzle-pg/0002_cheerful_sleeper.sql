/*
    drizzle-kit cannot yet resolve the existing primary key's constraint name, so it
    emitted the DROP commented out — which would fail here, since a table cannot gain a
    second PRIMARY KEY. The old constraint is PostgreSQL's default for an inline column
    PK, i.e. "<table>_pkey", so it is named explicitly below.

    Widening the PK from (message_id) to (message_id, agent_id): Feishu delivers the same
    message_id to every bot in a chat, so two Agents sharing a group each need their own
    row. Existing rows all satisfy the wider key, so no data is lost or de-duplicated.
*/

ALTER TABLE "feishu_pending_messages" DROP CONSTRAINT "feishu_pending_messages_pkey";--> statement-breakpoint
ALTER TABLE "feishu_pending_messages" ADD CONSTRAINT "feishu_pending_messages_message_id_agent_id_pk" PRIMARY KEY("message_id","agent_id");
