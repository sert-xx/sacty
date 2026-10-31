function createShutdownHandler({ getChild, stop, abort, onStopping, onStopped, onFailure }) {
  let pending;
  let complete = false;
  return (event) => {
    abort();
    if (complete) return;
    if (pending) {
      event.preventDefault();
      return pending;
    }
    const child = getChild();
    if (!child) return;
    event.preventDefault();
    onStopping();
    pending = Promise.resolve()
      .then(() => stop(child))
      .then(() => {
        complete = true;
        onStopped();
      })
      .catch(() => {
        pending = undefined;
        onFailure();
      });
    return pending;
  };
}
module.exports = { createShutdownHandler };
