package app.markiro.handheld.core.replacement

import app.markiro.handheld.core.grants.WorkAdmissionDenied

/** A durable replacement drain refuses new work while existing recovery remains available. */
class ReplacementDenied : WorkAdmissionDenied("Device replacement: new work is blocked")
