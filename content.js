function highlightImportantText() {
    document.querySelectorAll("p").forEach(paragraph => {
      paragraph.style.backgroundColor = "yellow";
    });
  }
  highlightImportantText();