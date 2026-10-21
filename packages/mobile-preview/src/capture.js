(() => {
  const pending = new WeakMap()
  window.captureMobilePreviewFrame = (queue, source) => {
    if (pending.has(queue)) return pending.get(queue)
    const promise = new Promise((resolve, reject) => {
      const original = queue.submit
      let scheduled = false
      const finish = () => { clearTimeout(timeout); queue.submit = original; pending.delete(queue) }
      const timeout = setTimeout(() => { finish(); reject(new Error('The mobile preview did not render a frame. Restore it and retry.')) }, 5000)
      queue.submit = function (...args) {
        const result = original.apply(this, args)
        if (!scheduled) {
          scheduled = true
          // The canvas is cleared after presentation; copy after the frame's final GPU submission.
          queueMicrotask(() => {
            try {
              const frame = document.createElement('canvas')
              const scale = Math.min(1, 1024 / Math.max(source.width, source.height))
              frame.width = Math.max(1, Math.round(source.width * scale))
              frame.height = Math.max(1, Math.round(source.height * scale))
              frame.getContext('2d').drawImage(source, 0, 0, frame.width, frame.height)
              finish()
              resolve(frame)
            } catch (error) { finish(); reject(error) }
          })
        }
        return result
      }
    })
    pending.set(queue, promise)
    return promise
  }
})()
