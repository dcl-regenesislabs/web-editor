import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { log } from '../../log'
import { MOBILE_SCAN_NOTE } from './publish-copy'

// The published scene on a phone: a QR of the mobile explorer's link, and the link itself
// as selectable text (the dialog's only controls live in its footer).
export function PublishMobileLink(props: { url: string }): JSX.Element {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setQr(null)
    QRCode.toDataURL(props.url, { width: 360, margin: 2 }).then(
      (src) => live && setQr(src),
      (err: unknown) => log.warn('could not draw the mobile QR', err)
    )
    return () => {
      live = false
    }
  }, [props.url])
  return (
    <div className="eui-publish-mobile">
      {qr !== null && <img className="eui-publish-qr" src={qr} alt="QR code to open the scene on your phone" />}
      <div className="eui-publish-mobile-text">
        <p className="eui-publish-caption">{MOBILE_SCAN_NOTE}</p>
        <p className="eui-publish-url">
          <span className="where">{props.url}</span>
        </p>
      </div>
    </div>
  )
}
