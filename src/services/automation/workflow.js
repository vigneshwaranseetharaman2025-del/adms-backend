const crypto = require('crypto');

/**
 * Workflow shape (stored in automations.workflow):
 * {
 *   steps: [
 *     { id, type: 'send_email', config: { sourceType: 'newsletter'|'template'|'custom', newsletterId, templateId, subject, htmlContent } },
 *     { id, type: 'wait', config: { amount, unit: 'minutes'|'hours'|'days' } },
 *     { id, type: 'condition', config: { check, stepId, field, operator, value }, branches: { yes: [...], no: [...] } },
 *     { id, type: 'end' }
 *   ]
 * }
 * The trigger is stored separately on the automation (trigger_type/trigger_config)
 * and is rendered as the first node in the UI.
 *
 * When a condition branch runs out of steps, execution continues with the step
 * that follows the condition (branches merge back), unless the branch hit End.
 */

const STEP_TYPES = ['send_email', 'wait', 'condition', 'end'];
const WAIT_UNITS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const CONDITION_CHECKS = ['email_opened', 'email_clicked', 'user_activated', 'field'];
const CONDITION_FIELDS = ['department', 'role', 'location', 'email'];
const CONDITION_OPERATORS = ['equals', 'not_equals', 'contains'];
const MAX_STEPS = 100;
const MAX_DEPTH = 5;

const newStepId = () => `s_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

const cleanString = (value, max = 255) => String(value ?? '').trim().slice(0, max);

/** Validates and normalises a workflow. Returns { workflow } or { error }. */
const validateWorkflow = (input) => {
  const seen = new Set();
  let count = 0;
  const sendSteps = [];

  const walk = (steps, depth, path) => {
    if (!Array.isArray(steps)) throw new Error(`${path} must be a list of steps.`);
    if (depth > MAX_DEPTH) throw new Error(`Conditions can be nested at most ${MAX_DEPTH} levels deep.`);
    const output = [];
    for (const raw of steps) {
      count += 1;
      if (count > MAX_STEPS) throw new Error(`A workflow can have at most ${MAX_STEPS} steps.`);
      const type = String(raw?.type || '');
      if (!STEP_TYPES.includes(type)) throw new Error(`Unknown step type "${type}".`);
      let id = cleanString(raw?.id, 64);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id)) id = newStepId();
      seen.add(id);
      const config = raw?.config && typeof raw.config === 'object' ? raw.config : {};
      const step = { id, type, config: {} };

      if (type === 'send_email') {
        const sourceType = ['newsletter', 'template', 'custom'].includes(config.sourceType) ? config.sourceType : 'custom';
        const subject = cleanString(config.subject, 255);
        if (!subject) throw new Error('Every Send email step needs a subject.');
        step.config = { sourceType, subject, name: cleanString(config.name, 120) || subject };
        if (sourceType === 'newsletter') {
          const newsletterId = parseInt(config.newsletterId, 10);
          if (!newsletterId) throw new Error(`Choose a campaign for "${subject}".`);
          step.config.newsletterId = newsletterId;
        } else if (sourceType === 'template') {
          const templateId = parseInt(config.templateId, 10);
          if (!templateId) throw new Error(`Choose a template for "${subject}".`);
          step.config.templateId = templateId;
        } else {
          const htmlContent = String(config.htmlContent || '').trim();
          if (!htmlContent) throw new Error(`Add email content for "${subject}".`);
          if (htmlContent.length > 500000) throw new Error('Email content is too large.');
          step.config.htmlContent = htmlContent;
        }
        sendSteps.push(step);
      }

      if (type === 'wait') {
        const amount = parseInt(config.amount, 10);
        const unit = Object.keys(WAIT_UNITS).includes(config.unit) ? config.unit : 'days';
        if (!amount || amount < 1 || amount > 1000) throw new Error('Wait steps need an amount between 1 and 1000.');
        step.config = { amount, unit };
      }

      if (type === 'condition') {
        const check = CONDITION_CHECKS.includes(config.check) ? config.check : null;
        if (!check) throw new Error('Choose what the condition checks.');
        step.config = { check };
        if (check === 'email_opened' || check === 'email_clicked') {
          step.config.stepId = cleanString(config.stepId, 64) || 'previous';
        }
        if (check === 'field') {
          if (!CONDITION_FIELDS.includes(config.field)) throw new Error('Choose a contact field for the condition.');
          step.config.field = config.field;
          step.config.operator = CONDITION_OPERATORS.includes(config.operator) ? config.operator : 'equals';
          step.config.value = cleanString(config.value, 200);
        }
        step.branches = {
          yes: walk(raw?.branches?.yes || [], depth + 1, 'Yes branch'),
          no: walk(raw?.branches?.no || [], depth + 1, 'No branch'),
        };
      }

      output.push(step);
      if (type === 'end') break; // anything after End is unreachable, drop it
    }
    return output;
  };

  try {
    const steps = walk(input?.steps || [], 0, 'Workflow');
    // Second pass: condition references must point at an earlier send step.
    const sendIds = new Set(sendSteps.map((s) => s.id));
    const checkRefs = (list) => list.forEach((step) => {
      if (step.type === 'condition') {
        const ref = step.config.stepId;
        if (ref && ref !== 'previous' && ref !== 'any' && !sendIds.has(ref)) {
          throw new Error('A condition refers to an email step that no longer exists.');
        }
        checkRefs(step.branches.yes);
        checkRefs(step.branches.no);
      }
    });
    checkRefs(steps);
    return { workflow: { steps }, sendSteps };
  } catch (error) {
    return { error: error.message };
  }
};

/**
 * Builds a lookup: stepId -> { step, next, yes, no, previousSendId }.
 * `next` already accounts for branch merging.
 */
const indexWorkflow = (workflow) => {
  const index = new Map();
  const build = (steps, continuation, lastSendId) => {
    let previousSend = lastSendId;
    steps.forEach((step, position) => {
      const following = position + 1 < steps.length ? steps[position + 1].id : continuation;
      const entry = { step, next: step.type === 'end' ? null : following, previousSendId: previousSend };
      index.set(step.id, entry);
      if (step.type === 'condition') {
        const yes = step.branches?.yes || [];
        const no = step.branches?.no || [];
        entry.yes = yes.length ? yes[0].id : following;
        entry.no = no.length ? no[0].id : following;
        build(yes, following, previousSend);
        build(no, following, previousSend);
      }
      if (step.type === 'send_email') previousSend = step.id;
    });
  };
  const steps = workflow?.steps || [];
  build(steps, null, null);
  return { index, firstStepId: steps.length ? steps[0].id : null };
};

const waitMs = (config) => (WAIT_UNITS[config.unit] || WAIT_UNITS.days) * (parseInt(config.amount, 10) || 1);

const countSteps = (workflow) => {
  let total = 0;
  const walk = (list) => list.forEach((step) => {
    total += 1;
    if (step.type === 'condition') { walk(step.branches?.yes || []); walk(step.branches?.no || []); }
  });
  walk(workflow?.steps || []);
  return total;
};

const listSendSteps = (workflow) => {
  const result = [];
  const walk = (list) => list.forEach((step) => {
    if (step.type === 'send_email') result.push(step);
    if (step.type === 'condition') { walk(step.branches?.yes || []); walk(step.branches?.no || []); }
  });
  walk(workflow?.steps || []);
  return result;
};

const exampleEmail = (heading, body) => `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#202124;padding:24px;max-width:600px;margin:0 auto">
<h2 style="margin-top:0">${heading}</h2>${body}
<p style="color:#5f6368;font-size:12px;margin-top:32px">You are receiving this because you have an account registered on {{registeredAt}}.</p>
</body></html>`;

/** The onboarding example from the spec: Registered → Welcome → 1d → Getting started → 3d → Follow-up → End. */
const exampleOnboardingWorkflow = () => ({
  steps: [
    {
      id: newStepId(), type: 'send_email',
      config: {
        sourceType: 'custom', name: 'Welcome email', subject: 'Welcome aboard, {{firstName}}!',
        htmlContent: exampleEmail('Welcome, {{firstName}} {{lastName}}', '<p>Your account <strong>{{email}}</strong> is ready. We are glad to have you with us.</p>'),
      },
    },
    { id: newStepId(), type: 'wait', config: { amount: 1, unit: 'days' } },
    {
      id: newStepId(), type: 'send_email',
      config: {
        sourceType: 'custom', name: 'Getting started', subject: '{{firstName}}, here is how to get started',
        htmlContent: exampleEmail('Getting started', '<p>Hi {{firstName}},</p><p>Here are three things to try first: update your profile, explore the document library, and check the latest newsletter.</p>'),
      },
    },
    { id: newStepId(), type: 'wait', config: { amount: 3, unit: 'days' } },
    {
      id: newStepId(), type: 'send_email',
      config: {
        sourceType: 'custom', name: 'Follow-up', subject: 'How is it going, {{firstName}}?',
        htmlContent: exampleEmail('Checking in', '<p>Hi {{firstName}},</p><p>It has been a few days since you joined. Reply to this email if there is anything we can help with.</p>'),
      },
    },
    { id: newStepId(), type: 'end', config: {} },
  ],
});

module.exports = {
  STEP_TYPES, WAIT_UNITS, CONDITION_CHECKS, CONDITION_FIELDS, CONDITION_OPERATORS,
  validateWorkflow, indexWorkflow, waitMs, countSteps, listSendSteps, exampleOnboardingWorkflow, newStepId,
};
