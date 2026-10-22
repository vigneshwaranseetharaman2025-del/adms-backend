const pool = require('../config/db');

// Who created and who last changed a campaign, for shared drafts.
const PEOPLE = `COALESCE(NULLIF(TRIM(cu.full_name), ''), cu.username) AS created_by_name,
  COALESCE(NULLIF(TRIM(uu.full_name), ''), uu.username) AS updated_by_name`;
const PEOPLE_JOIN = `LEFT JOIN users cu ON cu.id = n.created_by LEFT JOIN users uu ON uu.id = n.updated_by`;
const SENDER = `n.from_name AS "fromName", n.from_email AS "fromEmail", n.reply_to AS "replyTo"`;

/**
 * Every campaign of the organisation, drafts included. Drafts are shared: they are not filtered by
 * creator, so anyone with Campaigns access sees and can continue a colleague's draft.
 */
const listNewsletters = async () => (await pool.query(
  `SELECT n.id, n.title, n.subject, n.description, n.category, n.image_url, n.image_key, n.image_mime_type, n.html_content, n.is_blog, n.status,
          n.created_by, n.created_at, n.updated_at, n.updated_by, n.sent_at, n.recipient_count, n.visibility, ${SENDER}, ${PEOPLE}
   FROM newsletters n ${PEOPLE_JOIN}
   ORDER BY n.updated_at DESC, n.id DESC`
)).rows;

const listSentNewsletters = async (page = 1, pageSize = 10) => {
  const offset = (page - 1) * pageSize;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT n.id, n.title, n.subject, n.is_blog, n.status, n.sent_at, n.created_at,
              n.recipient_count,
              COALESCE(stats.delivered_count, 0)::int AS delivered_count,
              COALESCE(stats.opened_count, 0)::int AS opened_count,
              COALESCE(stats.clicked_count, 0)::int AS clicked_count,
              COALESCE(stats.recipients, '[]'::json) AS recipients
       FROM newsletters n
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE t.sent_at IS NOT NULL) AS delivered_count,
                COUNT(*) FILTER (WHERE t.opened_at IS NOT NULL) AS opened_count,
                COUNT(*) FILTER (WHERE t.clicked_at IS NOT NULL) AS clicked_count,
                json_agg(json_build_object(
                  'email', t.email,
                  'sentAt', t.sent_at,
                  'openedAt', t.opened_at,
                  'openCount', t.open_count,
                  'clickedAt', t.clicked_at,
                  'clickCount', t.click_count
                ) ORDER BY t.email) AS recipients
         FROM newsletter_tracking t WHERE t.newsletter_id = n.id
       ) stats ON TRUE
       WHERE n.status = 'sent'
       ORDER BY n.sent_at DESC NULLS LAST, n.id DESC
       LIMIT $1 OFFSET $2`, [pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM newsletters WHERE status = 'sent'`),
  ]);
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
};

const getNewsletterStats = async () => {
  const [totals, campaignCount] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(status, '') <> 'suppressed' AND (attempt_count > 0 OR sent_at IS NOT NULL))::int AS total_recipients,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS total_delivered,
         COUNT(*) FILTER (WHERE status = 'failed' AND sent_at IS NULL)::int AS total_failed,
         COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS total_opened,
         COALESCE(SUM(open_count), 0)::int AS total_open_events,
         COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS total_clicked
       FROM newsletter_tracking`
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM newsletters WHERE status = 'sent'`),
  ]);
  return { campaignsSent: campaignCount.rows[0].total, ...totals.rows[0] };
};

const findNewsletterById = async (id) => (await pool.query(
  `SELECT n.id, n.title, n.subject, n.description, n.category, n.image_url, n.image_key, n.image_mime_type, n.html_content, n.is_blog, n.status,
          n.created_by, n.created_at, n.updated_at, n.updated_by, n.sent_at, n.recipient_count, n.design_json AS "designJson", n.visibility, ${SENDER}, ${PEOPLE}
   FROM newsletters n ${PEOPLE_JOIN} WHERE n.id = $1`, [id]
)).rows[0] || null;

class SaveConflictError extends Error {
  constructor(current) {
    super('Someone else changed this campaign after you opened it.');
    this.status = 409;
    this.current = current;
  }
}

/**
 * Creates or updates a campaign. When baseUpdatedAt is given (the version the editor loaded), an update
 * made meanwhile by someone else is not silently overwritten: a SaveConflictError is thrown instead.
 */
const saveNewsletter = async ({ id, title, subject, description, category, imageUrl, htmlContent, isBlog, designJson = null, userId, fromName = null, fromEmail = null, replyTo = null, baseUpdatedAt = null, force = false }) => {
  const design = designJson ? JSON.stringify(designJson) : null;
  if (id) {
    if (baseUpdatedAt && !force) {
      const current = await findNewsletterById(id);
      if (!current) return null;
      const changedAfter = new Date(current.updated_at).getTime() - new Date(baseUpdatedAt).getTime() > 1;
      if (changedAfter && String(current.updated_by || '') !== String(userId)) throw new SaveConflictError(current);
    }
    const updated = (await pool.query(
      `UPDATE newsletters
      SET title = $1, subject = $2, description = $3, category = $4, image_url = $5, html_content = $6, is_blog = $7,
           design_json = $9::jsonb,
           from_name = $10, from_email = $11, reply_to = $12, updated_by = $13,
           status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'draft' END,
           updated_at = NOW()
      WHERE id = $8
      RETURNING id`,
          [title, subject, description, category, imageUrl, htmlContent, isBlog, id, design, fromName, fromEmail, replyTo, userId]
    )).rows[0];
    return updated ? findNewsletterById(updated.id) : null;
  }
  const created = (await pool.query(
      `INSERT INTO newsletters (title, subject, description, category, image_url, html_content, is_blog, created_by, design_json, from_name, from_email, reply_to, updated_by, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $8, 'organisation')
     RETURNING id`,
    [title, subject, description, category, imageUrl, htmlContent, isBlog, userId, design, fromName, fromEmail, replyTo]
  )).rows[0];
  return findNewsletterById(created.id);
};

const deleteNewsletterDraft = async (id) => {
  const result = await pool.query(
    `WITH draft AS (
       SELECT id FROM newsletters WHERE id = $1 AND status = 'draft'
     ), removed_images AS (
       DELETE FROM newsletter_images WHERE newsletter_id IN (SELECT id FROM draft)
       RETURNING storage_key
     ), removed_newsletter AS (
       DELETE FROM newsletters WHERE id IN (SELECT id FROM draft) AND status = 'draft'
       RETURNING id, image_key
     )
     SELECT removed_newsletter.id, removed_newsletter.image_key AS "imageKey",
            COALESCE((SELECT json_agg(storage_key) FROM removed_images WHERE storage_key IS NOT NULL), '[]'::json) AS "imageKeys"
     FROM removed_newsletter`,
    [id]
  );
  const deleted = result.rows[0];
  return deleted ? { ...deleted, storageKeys: [...deleted.imageKeys, deleted.imageKey].filter(Boolean) } : null;
};

const findOrganisationEmails = async () => (await pool.query(
  `SELECT DISTINCT LOWER(TRIM(email)) AS email FROM (
     SELECT email FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''
     UNION
     SELECT email FROM newsletter_contacts
   ) combined
   ORDER BY email`
)).rows.map((row) => row.email);

const listOrganisationRecipients = async () => (await pool.query(
  `SELECT id, contact_id AS "contactId", name, email, source FROM (
     SELECT DISTINCT ON (email) id, contact_id, name, email, source
     FROM (
       SELECT 'u-' || id AS id, NULL::int AS contact_id, COALESCE(NULLIF(TRIM(full_name), ''), username) AS name, LOWER(TRIM(email)) AS email, 'user' AS source
       FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''
       UNION ALL
       SELECT 'c-' || id AS id, id AS contact_id, name, LOWER(TRIM(email)) AS email, 'contact' AS source
       FROM newsletter_contacts
     ) combined
     ORDER BY email, (source = 'user') DESC
   ) deduped
   ORDER BY name, email`
)).rows;

const createNewsletterContact = async ({ name, email, userId }) => (await pool.query(
  `INSERT INTO newsletter_contacts (name, email, created_by)
   VALUES ($1, $2, $3)
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
   RETURNING 'c-' || id AS id, id AS "contactId", name, email, 'contact' AS source`,
  [name, email, userId]
)).rows[0];

const bulkImportNewsletterContacts = async (contacts, userId) => {
  let imported = 0;
  let skipped = 0;
  for (const contact of contacts) {
    try {
      const result = await pool.query(
        `INSERT INTO newsletter_contacts (name, email, source, created_by)
         VALUES ($1, $2, 'import', $3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [contact.name, contact.email, userId]
      );
      if (result.rows.length) imported += 1; else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped };
};

const deleteNewsletterContact = async (id) => (await pool.query(
  `DELETE FROM newsletter_contacts WHERE id = $1 RETURNING id`, [id]
)).rows[0] || null;

const listNewsletterGroups = async () => (await pool.query(
  `SELECT id, name, color, member_emails AS "memberEmails", created_at, updated_at
   FROM newsletter_groups ORDER BY name, id`
)).rows;

const listNewsletterImages = async (newsletterId) => (await pool.query(
  `SELECT id, newsletter_id AS "newsletterId", storage_key AS "storageKey", image_url AS "imageUrl", mime_type AS "mimeType", original_name AS "originalName", created_at AS "createdAt"
   FROM newsletter_images WHERE newsletter_id = $1 ORDER BY id`, [newsletterId]
)).rows;

const createNewsletterImage = async ({ newsletterId, storageKey, imageUrl, mimeType, originalName }) => (await pool.query(
  `INSERT INTO newsletter_images (newsletter_id, storage_key, image_url, mime_type, original_name)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, newsletter_id AS "newsletterId", storage_key AS "storageKey", image_url AS "imageUrl", mime_type AS "mimeType", original_name AS "originalName", created_at AS "createdAt"`,
  [newsletterId, storageKey, imageUrl, mimeType, originalName]
)).rows[0];

const updateNewsletterImageUrl = async (id, imageUrl) => (await pool.query(
  `UPDATE newsletter_images SET image_url = $1 WHERE id = $2 RETURNING id, newsletter_id AS "newsletterId", storage_key AS "storageKey", image_url AS "imageUrl", mime_type AS "mimeType", original_name AS "originalName", created_at AS "createdAt"`, [imageUrl, id]
)).rows[0] || null;

const findNewsletterImage = async (newsletterId, imageId) => (await pool.query(
  `SELECT id, newsletter_id AS "newsletterId", storage_key AS "storageKey", image_url AS "imageUrl", mime_type AS "mimeType"
   FROM newsletter_images WHERE newsletter_id = $1 AND id = $2`, [newsletterId, imageId]
)).rows[0] || null;

const deleteNewsletterImage = async (newsletterId, imageId) => (await pool.query(
  `DELETE FROM newsletter_images WHERE newsletter_id = $1 AND id = $2 RETURNING storage_key AS "storageKey"`, [newsletterId, imageId]
)).rows[0] || null;

const deleteNewsletterImages = async (newsletterId) => (await pool.query(
  `DELETE FROM newsletter_images WHERE newsletter_id = $1 RETURNING storage_key AS "storageKey"`, [newsletterId]
)).rows;

const createNewsletterGroup = async ({ name, color, memberEmails, userId }) => (await pool.query(
  `INSERT INTO newsletter_groups (name, color, member_emails, created_by)
   VALUES ($1, $2, $3::jsonb, $4)
   RETURNING id, name, color, member_emails AS "memberEmails", created_at, updated_at`,
  [name, color, JSON.stringify(memberEmails), userId]
)).rows[0];

const updateNewsletterGroup = async ({ id, name, color, memberEmails }) => (await pool.query(
  `UPDATE newsletter_groups SET name = $1, color = $2, member_emails = $3::jsonb, updated_at = NOW()
   WHERE id = $4
   RETURNING id, name, color, member_emails AS "memberEmails", created_at, updated_at`,
  [name, color, JSON.stringify(memberEmails), id]
)).rows[0] || null;

const deleteNewsletterGroup = async (id) => (await pool.query(
  `DELETE FROM newsletter_groups WHERE id = $1 RETURNING id`, [id]
)).rows[0] || null;

/** One row per recipient per send: a resend gets new rows and never resets the original send's opens. */
const createNewsletterTracking = async ({ newsletterId, email, trackingToken, sendId }) => (await pool.query(
  `INSERT INTO newsletter_tracking (newsletter_id, email, tracking_token, send_id)
   VALUES ($1, $2, $3, $4) ON CONFLICT (send_id, email)
   DO UPDATE SET tracking_token = EXCLUDED.tracking_token, sent_at = NULL, opened_at = NULL, open_count = 0
   RETURNING id, email, tracking_token AS "trackingToken"`, [newsletterId, email, trackingToken, sendId]
)).rows[0];

const markNewsletterTrackingSent = async (trackingToken) => pool.query(
  `UPDATE newsletter_tracking SET sent_at = NOW() WHERE tracking_token = $1`, [trackingToken]
);

const markNewsletterOpened = async (trackingToken) => (await pool.query(
  `UPDATE newsletter_tracking SET opened_at = COALESCE(opened_at, NOW()), open_count = open_count + 1,
          status = CASE WHEN status = 'uncertain' THEN 'accepted' ELSE status END,
          sent_at = CASE WHEN status = 'uncertain' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
   WHERE tracking_token = $1 RETURNING newsletter_id, email`, [trackingToken]
)).rows[0] || null;

const markNewsletterClicked = async (trackingToken) => (await pool.query(
  `UPDATE newsletter_tracking SET opened_at = COALESCE(opened_at, NOW()), open_count = GREATEST(open_count, 1),
    clicked_at = COALESCE(clicked_at, NOW()), click_count = click_count + 1,
    status = CASE WHEN status = 'uncertain' THEN 'accepted' ELSE status END,
    sent_at = CASE WHEN status = 'uncertain' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
   WHERE tracking_token = $1 RETURNING newsletter_id, email`, [trackingToken]
)).rows[0] || null;

const listNewsletterTracking = async (newsletterId) => (await pool.query(
  `SELECT email, sent_at AS "sentAt", opened_at AS "openedAt", open_count AS "openCount", clicked_at AS "clickedAt", click_count AS "clickCount"
   FROM newsletter_tracking WHERE newsletter_id = $1 ORDER BY opened_at DESC NULLS LAST, email`, [newsletterId]
)).rows;

const markNewsletterSent = async (id, recipientCount) => (await pool.query(
  `UPDATE newsletters SET status = 'sent', sent_at = NOW(), updated_at = NOW(), recipient_count = $2
   WHERE id = $1
  RETURNING id, title, subject, description, image_url, image_key, image_mime_type, html_content, status, created_by, created_at, updated_at, sent_at, recipient_count`,
  [id, recipientCount]
)).rows[0] || null;

const listPublishedNewsletters = async (page = 1, pageSize = 6) => {
  const offset = (page - 1) * pageSize;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT id, title, subject, description, category, image_url, image_key, image_mime_type, status, sent_at, created_at
      FROM newsletters WHERE status = 'sent' AND is_blog = TRUE ORDER BY sent_at DESC NULLS LAST, id DESC
       LIMIT $1 OFFSET $2`, [pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM newsletters WHERE status = 'sent' AND is_blog = TRUE`),
  ]);
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
};

const findPublishedNewsletterById = async (id) => (await pool.query(
  `SELECT id, title, subject, description, category, image_url, image_key, image_mime_type, html_content, status, sent_at, created_at
  FROM newsletters WHERE id = $1 AND status = 'sent' AND is_blog = TRUE`, [id]
)).rows[0] || null;

const updateNewsletterImage = async (id, imageKey, imageUrl, imageMimeType) => (await pool.query(
  `UPDATE newsletters SET image_key = $1, image_url = $2, image_mime_type = $3, updated_at = NOW()
   WHERE id = $4 RETURNING id, image_key, image_url, image_mime_type`, [imageKey, imageUrl, imageMimeType, id]
)).rows[0] || null;

const listNewsletterTemplates = async () => (await pool.query(
  `SELECT id, slug, name, description, category, html_content AS "htmlContent", is_builtin AS "isBuiltin", created_at AS "createdAt", design_json AS "designJson"
   FROM newsletter_templates ORDER BY is_builtin DESC, name`
)).rows;

const findNewsletterTemplateById = async (id) => (await pool.query(
  `SELECT id, slug, name, description, category, html_content AS "htmlContent", is_builtin AS "isBuiltin", created_at AS "createdAt", design_json AS "designJson"
   FROM newsletter_templates WHERE id = $1`, [id]
)).rows[0] || null;

const createNewsletterTemplate = async ({ name, description, category, htmlContent, designJson = null, userId }) => (await pool.query(
  `INSERT INTO newsletter_templates (name, description, category, html_content, is_builtin, created_by, design_json)
   VALUES ($1, $2, $3, $4, FALSE, $5, $6::jsonb)
   RETURNING id, slug, name, description, category, html_content AS "htmlContent", is_builtin AS "isBuiltin", created_at AS "createdAt", design_json AS "designJson"`,
  [name, description, category, htmlContent, userId, designJson ? JSON.stringify(designJson) : null]
)).rows[0];

const deleteNewsletterTemplate = async (id) => (await pool.query(
  `DELETE FROM newsletter_templates WHERE id = $1 AND is_builtin = FALSE RETURNING id`, [id]
)).rows[0] || null;

module.exports = { SaveConflictError, listNewsletters, listSentNewsletters, getNewsletterStats, findNewsletterById, saveNewsletter, deleteNewsletterDraft, findOrganisationEmails, listOrganisationRecipients, createNewsletterContact, bulkImportNewsletterContacts, deleteNewsletterContact, listNewsletterGroups, createNewsletterGroup, updateNewsletterGroup, deleteNewsletterGroup, listNewsletterImages, createNewsletterImage, updateNewsletterImageUrl, findNewsletterImage, deleteNewsletterImage, deleteNewsletterImages, createNewsletterTracking, markNewsletterTrackingSent, markNewsletterOpened, markNewsletterClicked, listNewsletterTracking, markNewsletterSent, listPublishedNewsletters, findPublishedNewsletterById, updateNewsletterImage, listNewsletterTemplates, findNewsletterTemplateById, createNewsletterTemplate, deleteNewsletterTemplate };