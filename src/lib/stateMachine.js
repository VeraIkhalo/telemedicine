// Consultation lifecycle. Each transition lists which roles may perform it.
const TRANSITIONS = {
  pending_payment: { scheduled: ['system'], cancelled: ['system', 'patient', 'admin'] },
  scheduled: {
    in_progress: ['doctor'],
    cancelled: ['patient', 'doctor', 'admin'],
    no_show: ['doctor'],
  },
  in_progress: { completed: ['doctor'] },
  completed: {},
  cancelled: {},
  no_show: {},
};

function canTransition(from, to, role) {
  const allowed = TRANSITIONS[from]?.[to];
  return Array.isArray(allowed) && allowed.includes(role);
}

module.exports = { TRANSITIONS, canTransition };
