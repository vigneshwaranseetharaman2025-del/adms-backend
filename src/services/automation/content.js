const pool = require('../../config/db');
const newsletterModel = require('../../models/newsletterModel');

/** Resolves the HTML for a Send email step / scheduled email from existing campaigns and templates. */
const resolveEmailContent = async ({ sourceType, newsletterId, templateId, htmlContent }) => {
  if (sourceType === 'newsletter') {
    const newsletter = await newsletterModel.findNewsletterById(newsletterId);
    if (!newsletter) throw new Error(`Campaign #${newsletterId} no longer exists.`);
    return newsletter.html_content;
  }
  if (sourceType === 'template') {
    const template = await newsletterModel.findNewsletterTemplateById(templateId);
    if (!template) throw new Error(`Template #${templateId} no longer exists.`);
    return template.htmlContent;
  }
  if (!htmlContent) throw new Error('Email content is empty.');
  return htmlContent;
};

/**
 * Audience = the same recipients the campaign composer offers:
 * all organisation emails, a saved contact list (group), or picked emails.
 */
const resolveAudience = async ({ type, groupId, emails }) => {
  const valid = new Set(await newsletterModel.findOrganisationEmails());
  if (type === 'all') return [...valid];
  if (type === 'group') {
    const group = (await pool.query('SELECT member_emails FROM newsletter_groups WHERE id = $1', [groupId])).rows[0];
    if (!group) throw new Error('The selected contact list no longer exists.');
    return [...new Set((group.member_emails || []).map((e) => String(e).trim().toLowerCase()))].filter((e) => valid.has(e));
  }
  return [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()))].filter((e) => valid.has(e));
};

module.exports = { resolveEmailContent, resolveAudience };
