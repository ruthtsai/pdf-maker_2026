# PDF Maker

A local tool for merging, converting and editing PDFs. Editing happens in the browser as a pending document; a real PDF is only built on export.

## Language

### Page editing

**Edit Session**:
The document a person is building in the browser, before anything is exported. It is an ordered list of Pages plus everything attached to them.
_Avoid_: Draft, editor state

**Draft**:
A dialog's uncommitted copy of one part of the Edit Session, which becomes one undoable change on Apply or is thrown away.

**Page**:
One entry in the Edit Session, referring to a page of a Source with its own rotation. It keeps its identity when moved.

**Source**:
An uploaded file that Pages are drawn from.

**Edit Recipe**:
The description of an Edit Session sent to the server to build a preview or an export.
_Avoid_: Payload, export request

### References to pages

**Page-following reference**:
A reference that stays with its Page wherever the Page moves, and passes to the Page that replaces it. Bookmarks and page-limited Stamps are page-following.

**Position reference**:
A reference to a place in the output order, regardless of which Page is there. Page label rules and printed page numbering are position references.

**Replace**:
Swapping a Page for a different one at the same position; page-following references carry over to the new Page.
