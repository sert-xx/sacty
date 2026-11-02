// 会議室の予約の、作成と変更の検査（変更後）。before.mjs に、予約の変更（changeReservation）を足し、
// 作成の検査を validateFormat・validateRules に分けて共通にしたもの（実験 S12 の形）。

export class ValidationError extends Error {}
export class BusinessRuleError extends Error {}

const MINUTE_MS = 60_000;
const SLOT_MINUTES = 15;
const MAX_DURATION_MINUTES = 240;

function validateFormat(input) {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 100) {
    throw new ValidationError("Reservation title must be 1-100 characters");
  }
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new ValidationError("Reservation must end after it starts");
  }
  if (!Number.isInteger(input.attendees) || input.attendees < 1) {
    throw new ValidationError("Attendees must be a positive integer");
  }

  const slotMs = SLOT_MINUTES * MINUTE_MS;
  if (input.startsAt.getTime() % slotMs !== 0 || input.endsAt.getTime() % slotMs !== 0) {
    throw new ValidationError(`Reservation times must be aligned to ${SLOT_MINUTES} minutes`);
  }
  return title;
}

function validateRules(input) {
  const minutes = (input.endsAt.getTime() - input.startsAt.getTime()) / MINUTE_MS;
  if (minutes > MAX_DURATION_MINUTES) {
    throw new BusinessRuleError(`A reservation can be at most ${MAX_DURATION_MINUTES} minutes`);
  }
  if (!input.room.isActive) {
    throw new BusinessRuleError(`Room "${input.room.name}" is not available for booking`);
  }
  if (input.attendees > input.room.capacity) {
    throw new BusinessRuleError(
      `Room "${input.room.name}" holds at most ${input.room.capacity} people`,
    );
  }
}

/**
 * Builds a reservation after checking the rules that only need the room, the member and the clock.
 * Overlap with other reservations needs the repository, so the use case checks that separately.
 */
export function newReservation(input) {
  const title = validateFormat(input);
  validateRules(input);
  if (input.startsAt.getTime() <= input.now.getTime()) {
    throw new BusinessRuleError("Reservations must start in the future");
  }

  return {
    id: input.id,
    roomId: input.room.id,
    memberId: input.memberId,
    title,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    attendees: input.attendees,
    cancelledAt: null,
  };
}

export function changeReservation(reservation, input) {
  const { changes, now } = input;
  if (!["title", "startsAt", "endsAt", "attendees"].some((key) => key in changes)) {
    throw new ValidationError("At least one reservation field must be provided");
  }
  const values = { ...reservation, ...changes };
  const title = validateFormat(values);
  if (reservation.cancelledAt !== null || reservation.endsAt.getTime() <= now.getTime()) {
    throw new BusinessRuleError("Cancelled or ended reservations cannot be changed");
  }
  const inProgress = reservation.startsAt.getTime() <= now.getTime();
  if (inProgress && Object.keys(changes).some((key) => key !== "endsAt")) {
    throw new BusinessRuleError("Only the end time of an in-progress reservation can be changed");
  }
  validateRules({ ...values, room: input.room });
  if (!inProgress && values.startsAt.getTime() <= now.getTime()) {
    throw new BusinessRuleError("Reservations must start in the future");
  }
  return {
    ...reservation,
    title,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    attendees: values.attendees,
  };
}
