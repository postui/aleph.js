import { useRouter } from 'framework/react'
import React from 'react'

export default function Query() {
  const router = useRouter()
  const color = router.params.name || 'white'
  const textColor = router.query.get('text') || 'black'

  return (
    <div>
      <head>
        <title>Color: {color}</title>
        <style>{`
          body {
            background: ${color};
            color: ${textColor};
          }
          nav a {
            color: ${textColor};
          }
        `}</style>
      </head>
      <div>
        <h1>{color}</h1>
      </div>
    </div>
  )
}
