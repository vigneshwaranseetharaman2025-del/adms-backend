const automationModel = require('../../models/automationModel');
const { indexWorkflow } = require('./workflow');
const { getRecipientProfile } = require('./personalization');

let nudge = () => {};
/** The scheduler registers itself so new enrollments start within a second instead of the next tick. */
const setNudge = (fn) => { nudge = fn; };

const TRIGGER_TYPES = ['user_registered', 'user_activated', 'email_opened', 'email_clicked', 'scheduled'];

const matchesConfig = (automation, payload) => {
  const config = automation.triggerConfig || {};
  if (automation.triggerType === 'email_opened' || automation.triggerType === 'email_clicked') {
    const wanted = parseInt(config.newsletterId, 10);
    return !wanted || wanted === Number(payload.newsletterId);
  }
  return true;
};

const enroll = async (automation, { email, userId, dedupeKey, context }) => {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  const { firstStepId } = indexWorkflow(automation.workflow);
  const profile = await getRecipientProfile(normalized);
  return automationModel.enrollContact({
    automationId: automation.id,
    email: normalized,
    userId: userId || profile.userId,
    dedupeKey,
    firstStepId,
    allowReentry: automation.allowReentry,
    context: { name: [profile.firstName, profile.lastName].filter(Boolean).join(' '), ...context },
  });
};

/**
 * Called from existing code paths (register, login, tracking pixel, click redirect).
 * Never throws into the caller — a broken automation must not break sign-in or tracking.
 */
const emitAutomationEvent = async (triggerType, payload) => {
  try {
    if (!TRIGGER_TYPES.includes(triggerType) || triggerType === 'scheduled') return 0;
    const automations = await automationModel.findActiveAutomationsByTrigger(triggerType);
    let enrolled = 0;
    for (const automation of automations) {
      if (!matchesConfig(automation, payload)) continue;
      const dedupeKey = `${triggerType}:${payload.eventKey || payload.email}`.slice(0, 255);
      const result = await enroll(automation, {
        email: payload.email,
        userId: payload.userId,
        dedupeKey,
        context: { trigger: triggerType, newsletterId: payload.newsletterId || undefined },
      });
      if (result) enrolled += 1;
    }
    if (enrolled) nudge();
    return enrolled;
  } catch (error) {
    console.error(`[automation] failed to handle ${triggerType} event:`, error.message);
    return 0;
  }
};

module.exports = { TRIGGER_TYPES, emitAutomationEvent, enroll, setNudge };
