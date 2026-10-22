-- Email automation schema (REFERENCE ONLY).
-- You do not need to run this: src/config/automationSchema.js creates all of it
-- automatically on server start (idempotent). Provided for DBA review.

ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

\restrict ha9oScTLT2E06sKmgBwLe9zjIS1fRoogV93GDrxHazYbEcKUP7keTQvm27Mclnn
CREATE TABLE public.automation_enrollments (
    id integer NOT NULL,
    automation_id integer NOT NULL,
    email character varying(320) NOT NULL,
    user_id integer,
    dedupe_key character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    current_step_id character varying(64),
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    locked_until timestamp with time zone,
    locked_by character varying(100),
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_enrollments_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'waiting'::character varying, 'completed'::character varying, 'failed'::character varying, 'exited'::character varying])::text[])))
);
CREATE SEQUENCE public.automation_enrollments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.automation_enrollments_id_seq OWNED BY public.automation_enrollments.id;
CREATE TABLE public.automation_step_runs (
    id integer NOT NULL,
    automation_id integer NOT NULL,
    enrollment_id integer NOT NULL,
    step_id character varying(64),
    step_type character varying(30) NOT NULL,
    status character varying(20) NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_step_runs_status_check CHECK (((status)::text = ANY ((ARRAY['completed'::character varying, 'waiting'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);
CREATE SEQUENCE public.automation_step_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.automation_step_runs_id_seq OWNED BY public.automation_step_runs.id;
CREATE TABLE public.automations (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    trigger_type character varying(40) NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    workflow jsonb DEFAULT '{"steps": []}'::jsonb NOT NULL,
    allow_reentry boolean DEFAULT false NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    activated_at timestamp with time zone,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automations_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'paused'::character varying])::text[]))),
    CONSTRAINT automations_trigger_type_check CHECK (((trigger_type)::text = ANY ((ARRAY['user_registered'::character varying, 'user_activated'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'scheduled'::character varying])::text[])))
);
CREATE SEQUENCE public.automations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.automations_id_seq OWNED BY public.automations.id;
CREATE TABLE public.email_logs (
    id integer NOT NULL,
    source character varying(20) NOT NULL,
    automation_id integer,
    enrollment_id integer,
    step_id character varying(64),
    scheduled_email_id integer,
    idempotency_key character varying(255) NOT NULL,
    recipient_email character varying(320) NOT NULL,
    subject character varying(500) NOT NULL,
    html_content text NOT NULL,
    tracking_token uuid NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    last_error text,
    message_id character varying(500),
    open_count integer DEFAULT 0 NOT NULL,
    click_count integer DEFAULT 0 NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    failed_at timestamp with time zone,
    bounced_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_logs_source_check CHECK (((source)::text = ANY ((ARRAY['automation'::character varying, 'scheduled'::character varying])::text[]))),
    CONSTRAINT email_logs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'sent'::character varying, 'delivered'::character varying, 'opened'::character varying, 'clicked'::character varying, 'failed'::character varying, 'bounced'::character varying])::text[])))
);
CREATE SEQUENCE public.email_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.email_logs_id_seq OWNED BY public.email_logs.id;
CREATE TABLE public.scheduled_emails (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    source_type character varying(20) NOT NULL,
    newsletter_id integer,
    template_id integer,
    subject character varying(255) NOT NULL,
    recipient_type character varying(20) NOT NULL,
    group_id integer,
    recipient_emails jsonb DEFAULT '[]'::jsonb NOT NULL,
    local_datetime character varying(19) NOT NULL,
    timezone character varying(64) NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    status character varying(20) DEFAULT 'scheduled'::character varying NOT NULL,
    recipient_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    last_error text,
    processed_at timestamp with time zone,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_emails_recipient_type_check CHECK (((recipient_type)::text = ANY ((ARRAY['all'::character varying, 'group'::character varying, 'contacts'::character varying])::text[]))),
    CONSTRAINT scheduled_emails_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['newsletter'::character varying, 'template'::character varying])::text[]))),
    CONSTRAINT scheduled_emails_status_check CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'processing'::character varying, 'sent'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);
CREATE SEQUENCE public.scheduled_emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.scheduled_emails_id_seq OWNED BY public.scheduled_emails.id;
ALTER TABLE ONLY public.automation_enrollments ALTER COLUMN id SET DEFAULT nextval('public.automation_enrollments_id_seq'::regclass);
ALTER TABLE ONLY public.automation_step_runs ALTER COLUMN id SET DEFAULT nextval('public.automation_step_runs_id_seq'::regclass);
ALTER TABLE ONLY public.automations ALTER COLUMN id SET DEFAULT nextval('public.automations_id_seq'::regclass);
ALTER TABLE ONLY public.email_logs ALTER COLUMN id SET DEFAULT nextval('public.email_logs_id_seq'::regclass);
ALTER TABLE ONLY public.scheduled_emails ALTER COLUMN id SET DEFAULT nextval('public.scheduled_emails_id_seq'::regclass);
ALTER TABLE ONLY public.automation_enrollments
    ADD CONSTRAINT automation_enrollments_automation_id_dedupe_key_key UNIQUE (automation_id, dedupe_key);
ALTER TABLE ONLY public.automation_enrollments
    ADD CONSTRAINT automation_enrollments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.automation_step_runs
    ADD CONSTRAINT automation_step_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_tracking_token_key UNIQUE (tracking_token);
ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_pkey PRIMARY KEY (id);
CREATE INDEX idx_automations_trigger ON public.automations USING btree (trigger_type, status);
CREATE INDEX idx_email_logs_automation ON public.email_logs USING btree (automation_id, step_id);
CREATE INDEX idx_email_logs_enrollment ON public.email_logs USING btree (enrollment_id);
CREATE INDEX idx_email_logs_message_id ON public.email_logs USING btree (message_id);
CREATE INDEX idx_email_logs_queue ON public.email_logs USING btree (next_attempt_at) WHERE ((status)::text = 'queued'::text);
CREATE INDEX idx_email_logs_queued_at ON public.email_logs USING btree (queued_at DESC);
CREATE INDEX idx_email_logs_scheduled ON public.email_logs USING btree (scheduled_email_id);
CREATE INDEX idx_enrollments_automation ON public.automation_enrollments USING btree (automation_id, started_at DESC);
CREATE INDEX idx_enrollments_due ON public.automation_enrollments USING btree (next_run_at) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'waiting'::character varying])::text[]));
CREATE INDEX idx_scheduled_emails_due ON public.scheduled_emails USING btree (scheduled_at) WHERE ((status)::text = 'scheduled'::text);
CREATE INDEX idx_step_runs_automation ON public.automation_step_runs USING btree (automation_id, created_at DESC);
CREATE INDEX idx_step_runs_enrollment ON public.automation_step_runs USING btree (enrollment_id, created_at);
CREATE UNIQUE INDEX uq_enrollment_inflight ON public.automation_enrollments USING btree (automation_id, email) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'waiting'::character varying])::text[]));
ALTER TABLE ONLY public.automation_enrollments
    ADD CONSTRAINT automation_enrollments_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_enrollments
    ADD CONSTRAINT automation_enrollments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.automation_step_runs
    ADD CONSTRAINT automation_step_runs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automation_step_runs
    ADD CONSTRAINT automation_step_runs_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.automation_enrollments(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.automation_enrollments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_scheduled_email_id_fkey FOREIGN KEY (scheduled_email_id) REFERENCES public.scheduled_emails(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
\unrestrict ha9oScTLT2E06sKmgBwLe9zjIS1fRoogV93GDrxHazYbEcKUP7keTQvm27Mclnn
