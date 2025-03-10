/* eslint-env jest */
import webdriver from 'next-webdriver'
import { fetchViaHTTP, waitFor } from 'next-test-utils'
import { getNodeBySelector } from './utils'

async function resolveStreamResponse(response, onData) {
  let result = ''
  onData = onData || (() => {})
  await new Promise((resolve) => {
    response.body.on('data', (chunk) => {
      result += chunk.toString()
      onData(chunk.toString(), result)
    })

    response.body.on('end', resolve)
  })
  return result
}

export default function (context, { env, runtime }) {
  it('should support streaming for fizz response', async () => {
    await fetchViaHTTP(context.appPort, '/streaming', null, {}).then(
      async (response) => {
        let gotFallback = false
        let gotData = false

        await resolveStreamResponse(response, (_, result) => {
          gotData = result.includes('next_streaming_data')
          if (!gotFallback) {
            gotFallback = result.includes('next_streaming_fallback')
            if (gotFallback) {
              expect(gotData).toBe(false)
            }
          }
        })

        expect(gotFallback).toBe(true)
        expect(gotData).toBe(true)
      }
    )

    // Should end up with "next_streaming_data".
    const browser = await webdriver(context.appPort, '/streaming')
    const content = await browser.eval(`window.document.body.innerText`)
    expect(content).toMatchInlineSnapshot('"next_streaming_data"')
  })

  it('should support streaming for flight response', async () => {
    await fetchViaHTTP(context.appPort, '/?__flight__=1').then(
      async (response) => {
        const result = await resolveStreamResponse(response)
        expect(result).toContain('component:index.server')
      }
    )
  })

  it('should support partial hydration with inlined server data', async () => {
    await fetchViaHTTP(context.appPort, '/partial-hydration', null, {}).then(
      async (response) => {
        let gotFallback = false
        let gotData = false
        let gotInlinedData = false

        await resolveStreamResponse(response, (_, result) => {
          gotInlinedData = result.includes('self.__next_s=')
          gotData = result.includes('next_streaming_data')
          if (!gotFallback) {
            gotFallback = result.includes('next_streaming_fallback')
            if (gotFallback) {
              expect(gotData).toBe(false)
              expect(gotInlinedData).toBe(false)
            }
          }
        })

        expect(gotFallback).toBe(true)
        expect(gotData).toBe(true)
        expect(gotInlinedData).toBe(true)
      }
    )

    // Should end up with "next_streaming_data".
    const browser = await webdriver(context.appPort, '/partial-hydration')
    const content = await browser.eval(`window.document.body.innerText`)
    expect(content).toContain('next_streaming_data')

    // Should support partial hydration: the boundary should still be pending
    // while another part is hydrated already.
    expect(await browser.eval(`window.partial_hydration_suspense_result`)).toBe(
      'next_streaming_fallback'
    )
    expect(await browser.eval(`window.partial_hydration_counter_result`)).toBe(
      'count: 1'
    )
  })

  it('should flush the suffix at the very end', async () => {
    await fetchViaHTTP(context.appPort, '/').then(async (response) => {
      const result = await resolveStreamResponse(response)
      expect(result).toMatch(/<\/body><\/html>/)
    })
  })

  if (env === 'dev') {
    it('should warn when stylesheets or scripts are in head', async () => {
      let browser
      try {
        browser = await webdriver(context.appPort, '/head')

        await browser.waitForElementByCss('h1')
        await waitFor(1000)
        const browserLogs = await browser.log('browser')
        let foundStyles = false
        let foundScripts = false
        const logs = []
        browserLogs.forEach(({ message }) => {
          if (message.includes('Do not add stylesheets using next/head')) {
            foundStyles = true
            logs.push(message)
          }
          if (message.includes('Do not add <script> tags using next/head')) {
            foundScripts = true
            logs.push(message)
          }
        })

        expect(foundStyles).toEqual(true)
        expect(foundScripts).toEqual(true)

        // Warnings are unique
        expect(logs.length).toEqual(new Set(logs).size)
      } finally {
        if (browser) {
          await browser.close()
        }
      }
    })

    it('should warn when scripts are in head', async () => {
      let browser
      try {
        browser = await webdriver(context.appPort, '/head')
        await browser.waitForElementByCss('h1')
        await waitFor(1000)
        const browserLogs = await browser.log('browser')
        let found = false
        browserLogs.forEach((log) => {
          if (log.message.includes('Use next/script instead')) {
            found = true
          }
        })
        expect(found).toEqual(true)
      } finally {
        if (browser) {
          await browser.close()
        }
      }
    })

    it('should not warn when application/ld+json scripts are in head', async () => {
      let browser
      try {
        browser = await webdriver(context.appPort, '/head-with-json-ld-snippet')
        await browser.waitForElementByCss('h1')
        await waitFor(1000)
        const browserLogs = await browser.log('browser')
        let found = false
        browserLogs.forEach((log) => {
          if (log.message.includes('Use next/script instead')) {
            found = true
          }
        })
        expect(found).toEqual(false)
      } finally {
        if (browser) {
          await browser.close()
        }
      }
    })
  }

  it('should stream to users', async () => {
    const res = await fetchViaHTTP(context.appPort, '/streaming')
    let flushCount = 0
    await resolveStreamResponse(res, () => {
      flushCount++
    })
    expect(flushCount).toBeGreaterThan(1)
    if (runtime === 'nodejs') {
      expect(res.headers.get('etag')).toBeNull()
    }
  })

  it('should not stream to crawlers or google pagerender bot', async () => {
    const res1 = await fetchViaHTTP(
      context.appPort,
      '/streaming',
      {},
      {
        headers: {
          'user-agent': 'Googlebot',
        },
      }
    )

    const res2 = await fetchViaHTTP(
      context.appPort,
      '/streaming',
      {},
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36 Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)',
        },
      }
    )
    let flushCount = 0
    await resolveStreamResponse(res2, () => {
      flushCount++
    })
    expect(flushCount).toBe(1)
    const html = await res1.text()
    const body = await getNodeBySelector(html, '#__next')
    // Resolve data instead of fallback
    expect(body.text()).toBe('next_streaming_data')

    if (runtime === 'nodejs') {
      expect(res1.headers.get('etag')).toBeDefined()
      expect(res2.headers.get('etag')).toBeDefined()
    }
  })
}
