// 会議室の予約の、作成の検査（変更前）。
// 実験 S12（会議室の予約 API）の apps/api/src/domain/reservation.ts を、検査の順番が分かる形に縮めたもの。
// ValidationError は HTTP の 400、BusinessRuleError は 422 に対応する。

export class ValidationError extends Error {}
export class BusinessRuleError extends Error {}

const MINUTE_MS = 60_000;
const SLOT_MINUTES = 15;
const MAX_DURATION_MINUTES = 240;

/**
 * Builds a reservation after checking the rules that only need the room, the member and the clock.
 * Overlap with other reservations needs the repository, so the use case checks that separately.
 */
export function newReservation(input) {
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
  const minutes = (input.endsAt.getTime() - input.startsAt.getTime()) / MINUTE_MS;
  if (minutes > MAX_DURATION_MINUTES) {
    throw new BusinessRuleError(`A reservation can be at most ${MAX_DURATION_MINUTES} minutes`);
  }
  if (input.startsAt.getTime() <= input.now.getTime()) {
    throw new BusinessRuleError("Reservations must start in the future");
  }
  if (!input.room.isActive) {
    throw new BusinessRuleError(`Room "${input.room.name}" is not available for booking`);
  }
  if (input.attendees > input.room.capacity) {
    throw new BusinessRuleError(
      `Room "${input.room.name}" holds at most ${input.room.capacity} people`,
    );
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
