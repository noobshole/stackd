/**
 * Provenance check tests.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { checkProvenance } from './provenance.js';

/** A JPEG-shaped buffer: SOI, one APP1 segment carrying `meta`, noise, EOI. */
function jpegWith(meta: string): Buffer {
  const payload = Buffer.from(meta, 'utf8');
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    payload,
    randomBytes(64 * 1024),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const XMP = (body: string) =>
  `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>${body}</rdf:RDF></x:xmpmeta>`;

describe('test_provenance', () => {
  it('passes a plain camera photo', () => {
    const photo = jpegWith('Exif\0\0Apple\0iPhone 15 Pro\0iOS 19.1\0');
    assert.deepEqual(checkProvenance(photo), { ok: true });
  });

  it('refuses an image labelled AI-generated in XMP', () => {
    const image = jpegWith(
      XMP(
        '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/' +
          'trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>',
      ),
    );
    const verdict = checkProvenance(image);
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.kind, 'ai_generated');
  });

  it('refuses a composite with AI-generated parts', () => {
    const image = jpegWith(
      XMP('digitalsourcetype/compositeWithTrainedAlgorithmicMedia'),
    );
    assert.equal(checkProvenance(image).ok, false);
  });

  it('does not treat a genuine C2PA camera capture as AI', () => {
    // Some phones sign every photo; digitalCapture is the honest label.
    const image = jpegWith('jumb\0c2pa\0digitalsourcetype/digitalCapture');
    assert.deepEqual(checkProvenance(image), { ok: true });
  });

  it('refuses an image saved from a desktop editor', () => {
    const verdict = checkProvenance(jpegWith(XMP('<xmp:CreatorTool>Adobe Photoshop 26.0 (Windows)</xmp:CreatorTool>')));
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.kind, 'edited');
    assert.match(!verdict.ok ? verdict.reason : '', /Adobe Photoshop/);
    assert.equal(checkProvenance(jpegWith('Exif\0\0GIMP 2.10.38\0')).ok, false);
  });

  it('never fires on random image data', () => {
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(checkProvenance(randomBytes(1024 * 1024)), { ok: true });
    }
  });
});
