#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

/*
|--------------------------------------------------------------------------
| Usage
|--------------------------------------------------------------------------
|
| node script.js raw-paper.json
|
| Requirements:
| Node.js 18 or newer
|
| Output:
|
| jee_main_pyq_json/
|   └── Exact Paper Title.json
|
| jee_main_pyq_images/
|   └── media/
|       └── upload/
|           └── paper_slug/
|               ├── paper_slug_q001_question_img01.png
|               ├── paper_slug_q010_option_A_img01.png
|               └── paper_slug_q017_explanation_img01.png
|
*/

/*
|--------------------------------------------------------------------------
| Command-line arguments
|--------------------------------------------------------------------------
*/

const args = process.argv.slice(2);

if (!args[0]) {
  console.log(`
Usage:

  node script.js raw-paper.json

Example:

  node script.js jee-main-2026-paper.json
`);

  process.exit(1);
}

const inputFilePath = path.resolve(args[0]);

/*
|--------------------------------------------------------------------------
| Output configuration
|--------------------------------------------------------------------------
*/

const JSON_OUTPUT_DIRECTORY = path.resolve(
  "jee_main_pyq_json"
);

const IMAGE_OUTPUT_DIRECTORY = path.resolve(
  "jee_main_pyq_images",
  "media",
  "upload"
);

const PUBLIC_IMAGE_ROOT = "/media/upload";

const DOWNLOAD_RETRIES = 3;

const DOWNLOAD_TIMEOUT_MS = 30000;

/*
|--------------------------------------------------------------------------
| Supported image formats
|--------------------------------------------------------------------------
*/

const IMAGE_CONTENT_TYPE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

const VALID_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".avif",
]);

/*
|--------------------------------------------------------------------------
| Runtime data
|--------------------------------------------------------------------------
*/

const downloadedImageCache = new Map();

const imageManifest = [];

const imageFailures = [];

/*
|--------------------------------------------------------------------------
| General helpers
|--------------------------------------------------------------------------
*/

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, {
    recursive: true,
  });
}

function writeJson(filePath, data) {
  ensureDirectory(path.dirname(filePath));

  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || "unknown_paper";
}

function createSafeJsonFileName(paperTitle) {
  let safeName = String(
    paperTitle || "Unknown Paper"
  )
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "");

  if (!safeName) {
    safeName = "Unknown Paper";
  }

  return `${safeName}.json`;
}

function removeNullAndUndefinedFields(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      return value !== null && value !== undefined;
    })
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/*
|--------------------------------------------------------------------------
| Read and validate raw JSON
|--------------------------------------------------------------------------
*/

function readRawJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Input JSON file was not found:\n${filePath}`
    );
  }

  const fileContent = fs
    .readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "");

  let parsedJson;

  try {
    parsedJson = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `The input file is not valid JSON:\n${error.message}`
    );
  }

  if (
    !parsedJson ||
    typeof parsedJson !== "object" ||
    Array.isArray(parsedJson)
  ) {
    throw new Error(
      "The root JSON value must be an object."
    );
  }

  if (
    !Array.isArray(parsedJson.results) ||
    parsedJson.results.length === 0
  ) {
    throw new Error(
      "The raw JSON must contain a non-empty `results` array."
    );
  }

  return parsedJson;
}

/*
|--------------------------------------------------------------------------
| HTML helpers
|--------------------------------------------------------------------------
*/

function getHtmlAttribute(htmlTag, attributeName) {
  const pattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );

  const match = htmlTag.match(pattern);

  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, number) => {
      return String.fromCharCode(Number(number));
    });
}

function htmlToPlainText(html) {
  if (!html || typeof html !== "string") {
    return "";
  }

  let text = html;

  /*
   * Images are stored separately in image arrays.
   */
  text = text.replace(/<img\b[^>]*>/gi, "");

  /*
   * Convert block endings and line breaks.
   */
  text = text.replace(
    /<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi,
    "\n"
  );

  /*
   * Remove remaining HTML tags.
   */
  text = text.replace(/<[^>]+>/g, "");

  text = decodeHtmlEntities(text);

  text = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/*
|--------------------------------------------------------------------------
| Image helpers
|--------------------------------------------------------------------------
*/

function getExtensionFromImageUrl(imageUrl) {
  try {
    const parsedUrl = new URL(imageUrl);

    let extension = path
      .extname(parsedUrl.pathname)
      .toLowerCase();

    if (extension === ".jpeg") {
      extension = ".jpg";
    }

    if (VALID_IMAGE_EXTENSIONS.has(extension)) {
      return extension;
    }

    const requestedFormat =
      parsedUrl.searchParams.get("format") ||
      parsedUrl.searchParams.get("fm");

    if (requestedFormat) {
      let formatExtension = `.${requestedFormat
        .toLowerCase()
        .replace(/^\./, "")}`;

      if (formatExtension === ".jpeg") {
        formatExtension = ".jpg";
      }

      if (
        VALID_IMAGE_EXTENSIONS.has(formatExtension)
      ) {
        return formatExtension;
      }
    }
  } catch {
    // Use fallback.
  }

  return ".img";
}

async function fetchImage(imageUrl) {
  if (downloadedImageCache.has(imageUrl)) {
    return downloadedImageCache.get(imageUrl);
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= DOWNLOAD_RETRIES;
    attempt += 1
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(imageUrl, {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/150.0.0.0 Safari/537.36",

          Accept:
            "image/avif,image/webp,image/apng," +
            "image/svg+xml,image/*,*/*;q=0.8",
        },

        redirect: "follow",

        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }

      const contentType = String(
        response.headers.get("content-type") || ""
      )
        .split(";")[0]
        .trim()
        .toLowerCase();

      if (
        contentType &&
        !contentType.startsWith("image/")
      ) {
        throw new Error(
          `Expected image but received ${contentType}`
        );
      }

      const buffer = Buffer.from(
        await response.arrayBuffer()
      );

      if (buffer.length === 0) {
        throw new Error(
          "Downloaded image is empty."
        );
      }

      const imageData = {
        buffer,

        extension:
          IMAGE_CONTENT_TYPE_EXTENSIONS[contentType] ||
          getExtensionFromImageUrl(imageUrl),
      };

      downloadedImageCache.set(
        imageUrl,
        imageData
      );

      return imageData;
    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (attempt < DOWNLOAD_RETRIES) {
        await sleep(attempt * 1000);
      }
    }
  }

  throw (
    lastError ||
    new Error("Unknown image download error.")
  );
}

function createImageFileName({
  paperSlug,
  questionNumber,
  imageType,
  optionLabel,
  imageNumber,
  extension,
}) {
  const paddedQuestionNumber = String(
    questionNumber
  ).padStart(3, "0");

  const paddedImageNumber = String(
    imageNumber
  ).padStart(2, "0");

  let typePart = imageType;

  if (
    imageType === "option" &&
    optionLabel
  ) {
    typePart =
      `option_${String(optionLabel).toUpperCase()}`;
  }

  return (
    `${paperSlug}_` +
    `q${paddedQuestionNumber}_` +
    `${typePart}_` +
    `img${paddedImageNumber}` +
    `${extension}`
  );
}

/*
|--------------------------------------------------------------------------
| Process HTML and extract images
|--------------------------------------------------------------------------
*/

async function processHtmlContent(
  sourceHtml,
  {
    paperSlug,
    paperImageDirectory,
    questionNumber,
    imageType,
    optionLabel = null,
  }
) {
  if (
    typeof sourceHtml !== "string" ||
    sourceHtml.trim() === ""
  ) {
    return {
      text: "",
      html: "",
      images: [],
    };
  }

  const imagePattern = /<img\b[^>]*>/gi;

  const imageMatches = [
    ...sourceHtml.matchAll(imagePattern),
  ];

  let updatedHtml = sourceHtml;

  let replacementOffset = 0;

  const extractedImages = [];

  for (
    let index = 0;
    index < imageMatches.length;
    index += 1
  ) {
    const imageNumber = index + 1;

    const originalImageTag =
      imageMatches[index][0];

    const sourceImageUrl =
      getHtmlAttribute(
        originalImageTag,
        "data-orsrc"
      ) ||
      getHtmlAttribute(
        originalImageTag,
        "src"
      );

    if (!sourceImageUrl) {
      continue;
    }

    const altText =
      getHtmlAttribute(
        originalImageTag,
        "alt"
      ) || "";

    let imageExtension =
      getExtensionFromImageUrl(
        sourceImageUrl
      );

    let imageFileName =
      createImageFileName({
        paperSlug,
        questionNumber,
        imageType,
        optionLabel,
        imageNumber,
        extension: imageExtension,
      });

    let publicImageUrl =
      `${PUBLIC_IMAGE_ROOT}/` +
      `${paperSlug}/` +
      `${imageFileName}`;

    let downloadStatus = "failed";

    let errorMessage = null;

    try {
      const downloadedImage =
        await fetchImage(sourceImageUrl);

      imageExtension =
        downloadedImage.extension;

      imageFileName =
        createImageFileName({
          paperSlug,
          questionNumber,
          imageType,
          optionLabel,
          imageNumber,
          extension: imageExtension,
        });

      const physicalImagePath = path.join(
        paperImageDirectory,
        imageFileName
      );

      ensureDirectory(
        path.dirname(physicalImagePath)
      );

      fs.writeFileSync(
        physicalImagePath,
        downloadedImage.buffer
      );

      publicImageUrl =
        `${PUBLIC_IMAGE_ROOT}/` +
        `${paperSlug}/` +
        `${imageFileName}`;

      downloadStatus = "downloaded";
    } catch (error) {
      errorMessage = error.message;

      /*
       * Keep original URL if download fails.
       */
      publicImageUrl = sourceImageUrl;

      imageFailures.push({
        questionNumber,

        type:
          imageType === "option"
            ? `option_${optionLabel}`
            : imageType,

        imageNumber,

        sourceUrl:
          sourceImageUrl,

        error:
          errorMessage,
      });
    }

    const finalImageType =
      imageType === "option"
        ? `option_${String(
            optionLabel || ""
          ).toUpperCase()}`
        : imageType;

    const imageMetadata = {
      url:
        publicImageUrl,

      file_name:
        imageFileName,

      type:
        finalImageType,

      image_no:
        imageNumber,
    };

    if (altText) {
      imageMetadata.alt = altText;
    }

    extractedImages.push(
      imageMetadata
    );

    imageManifest.push({
      questionNumber,

      type:
        finalImageType,

      imageNumber,

      sourceUrl:
        sourceImageUrl,

      localUrl:
        publicImageUrl,

      fileName:
        imageFileName,

      status:
        downloadStatus,

      error:
        errorMessage,
    });

    const newImageTag =
      `<img ` +
      `class="img-responsive" ` +
      `data-image="${escapeHtmlAttribute(
        imageFileName
      )}" ` +
      `src="${escapeHtmlAttribute(
        publicImageUrl
      )}"` +
      `${
        altText
          ? ` alt="${escapeHtmlAttribute(
              altText
            )}"`
          : ""
      }` +
      ` loading="lazy">`;

    const replacementStart =
      imageMatches[index].index +
      replacementOffset;

    const replacementEnd =
      replacementStart +
      originalImageTag.length;

    updatedHtml =
      updatedHtml.slice(
        0,
        replacementStart
      ) +
      newImageTag +
      updatedHtml.slice(
        replacementEnd
      );

    replacementOffset +=
      newImageTag.length -
      originalImageTag.length;
  }

  return {
    text:
      htmlToPlainText(sourceHtml),

    html:
      updatedHtml.trim(),

    images:
      extractedImages,
  };
}

/*
|--------------------------------------------------------------------------
| Correct answer normalization
|--------------------------------------------------------------------------
*/

function getCorrectAnswer(rawQuestion) {
  const englishQuestion =
    rawQuestion.question?.en || {};

  if (rawQuestion.type === "mcq") {
    return {
      type: "option",

      value: Array.isArray(
        englishQuestion.correct_options
      )
        ? englishQuestion.correct_options
        : [],
    };
  }

  if (rawQuestion.type === "integer") {
    return {
      type: "integer",

      value:
        englishQuestion.answer === null ||
        englishQuestion.answer === undefined
          ? null
          : String(
              englishQuestion.answer
            ).trim(),
    };
  }

  return {
    type:
      rawQuestion.type || "unknown",

    value:
      englishQuestion.answer === null ||
      englishQuestion.answer === undefined
        ? null
        : String(
            englishQuestion.answer
          ).trim(),
  };
}

/*
|--------------------------------------------------------------------------
| Validation
|--------------------------------------------------------------------------
*/

function validatePaper(cleanPaper) {
  const issues = [];

  const subjectCounts = {};

  const typeCounts = {};

  for (
    const question of cleanPaper.questions
  ) {
    subjectCounts[question.subject] =
      (subjectCounts[question.subject] || 0) +
      1;

    typeCounts[question.type] =
      (typeCounts[question.type] || 0) +
      1;

    if (!question.questionText) {
      issues.push({
        questionNumber:
          question.number,

        issue:
          "Question text is empty.",
      });
    }

    if (!question.questionHtml) {
      issues.push({
        questionNumber:
          question.number,

        issue:
          "Question HTML is empty.",
      });
    }

    if (!question.explanationHtml) {
      issues.push({
        questionNumber:
          question.number,

        issue:
          "Explanation is empty.",
      });
    }

    if (question.type === "mcq") {
      if (
        !Array.isArray(
          question.correctAnswer?.value
        ) ||
        question.correctAnswer.value
          .length === 0
      ) {
        issues.push({
          questionNumber:
            question.number,

          issue:
            "Correct MCQ option is missing.",
        });
      }

      const availableOptionLabels =
        new Set(
          question.options.map(
            (option) => option.label
          )
        );

      for (
        const correctOption
        of question.correctAnswer?.value || []
      ) {
        if (
          !availableOptionLabels.has(
            correctOption
          )
        ) {
          issues.push({
            questionNumber:
              question.number,

            issue:
              `Correct option ${correctOption} ` +
              `is not available in the option list.`,
          });
        }
      }
    }

    if (
      question.type === "integer" &&
      (
        question.correctAnswer?.value === null ||
        question.correctAnswer?.value === ""
      )
    ) {
      issues.push({
        questionNumber:
          question.number,

        issue:
          "Integer answer is missing.",
      });
    }
  }

  return {
    isValid:
      issues.length === 0,

    totalQuestions:
      cleanPaper.questions.length,

    subjectCounts,

    typeCounts,

    totalImageOccurrences:
      imageManifest.length,

    failedImageDownloads:
      imageFailures.length,

    issues,
  };
}

/*
|--------------------------------------------------------------------------
| Main conversion
|--------------------------------------------------------------------------
*/

async function convertPaper() {
  const rawJson =
    readRawJson(inputFilePath);

  const rawQuestions =
    rawJson.results;

  const firstQuestion =
    rawQuestions[0];

  const paperTitle =
    firstQuestion.paperTitle ||
    firstQuestion.paperId ||
    "Unknown Paper";

  const paperSlug = slugify(
    firstQuestion.paperId ||
    firstQuestion.yearKey ||
    paperTitle ||
    path.basename(
      inputFilePath,
      path.extname(inputFilePath)
    )
  );

  const finalJsonFileName =
    createSafeJsonFileName(
      paperTitle
    );

  const finalJsonPath = path.join(
    JSON_OUTPUT_DIRECTORY,
    finalJsonFileName
  );

  const paperImageDirectory = path.join(
    IMAGE_OUTPUT_DIRECTORY,
    paperSlug
  );

  ensureDirectory(
    JSON_OUTPUT_DIRECTORY
  );

  ensureDirectory(
    paperImageDirectory
  );

  const subjectQuestionNumbers = {};

  const cleanQuestions = [];

  for (
    let index = 0;
    index < rawQuestions.length;
    index += 1
  ) {
    const rawQuestion =
      rawQuestions[index];

    const questionNumber =
      index + 1;

    const subject = String(
      rawQuestion.subject || "unknown"
    ).toLowerCase();

    subjectQuestionNumbers[subject] =
      (
        subjectQuestionNumbers[subject] ||
        0
      ) + 1;

    /*
     * Keep English only.
     */
    const english =
      rawQuestion.question?.en || {};

    const processedQuestion =
      await processHtmlContent(
        english.content || "",
        {
          paperSlug,
          paperImageDirectory,
          questionNumber,
          imageType: "question",
        }
      );

    const cleanOptions = [];

    for (
      const rawOption
      of english.options || []
    ) {
      const optionLabel = String(
        rawOption.identifier || ""
      ).trim();

      const processedOption =
        await processHtmlContent(
          rawOption.content || "",
          {
            paperSlug,
            paperImageDirectory,
            questionNumber,
            imageType: "option",
            optionLabel,
          }
        );

      cleanOptions.push({
        label:
          optionLabel,

        text:
          processedOption.text,

        html:
          processedOption.html,

        images:
          processedOption.images,
      });
    }

    const processedExplanation =
      await processHtmlContent(
        english.explanation || "",
        {
          paperSlug,
          paperImageDirectory,
          questionNumber,
          imageType: "explanation",
        }
      );

    let processedDirection = null;

    if (english.direction) {
      processedDirection =
        await processHtmlContent(
          english.direction,
          {
            paperSlug,
            paperImageDirectory,
            questionNumber,
            imageType: "direction",
          }
        );
    }

    let processedComprehension = null;

    if (english.comprehension) {
      processedComprehension =
        await processHtmlContent(
          english.comprehension,
          {
            paperSlug,
            paperImageDirectory,
            questionNumber,
            imageType:
              "comprehension",
          }
        );
    }

    const cleanQuestion =
      removeNullAndUndefinedFields({
        number:
          questionNumber,

        subjectQuestionNumber:
          subjectQuestionNumbers[
            subject
          ],

        subject,

        chapter:
          rawQuestion.chapter,

        chapterGroup:
          rawQuestion.chapterGroup,

        topic:
          rawQuestion.topic,

        difficulty:
          rawQuestion.difficulty,

        type:
          rawQuestion.type,

        marks:
          rawQuestion.marks,

        negativeMarks:
          rawQuestion.negMarks,

        isBonus:
          Boolean(
            rawQuestion.isBonus
          ),

        isOutOfSyllabus:
          Boolean(
            rawQuestion
              .isOutOfSyllabus
          ),

        directionText:
          processedDirection?.text,

        directionHtml:
          processedDirection?.html,

        directionImages:
          processedDirection?.images,

        comprehensionText:
          processedComprehension?.text,

        comprehensionHtml:
          processedComprehension?.html,

        comprehensionImages:
          processedComprehension?.images,

        questionText:
          processedQuestion.text,

        questionHtml:
          processedQuestion.html,

        images:
          processedQuestion.images,

        options:
          cleanOptions,

        correctAnswer:
          getCorrectAnswer(
            rawQuestion
          ),

        explanationText:
          processedExplanation.text,

        explanationHtml:
          processedExplanation.html,

        explanationImages:
          processedExplanation.images,
      });

    cleanQuestions.push(
      cleanQuestion
    );

    process.stdout.write(
      `\rProcessed ${questionNumber}` +
      `/${rawQuestions.length} questions`
    );
  }

  process.stdout.write("\n");

  const uniqueMarks = [
    ...new Set(
      rawQuestions
        .map(
          (question) =>
            question.marks
        )
        .filter(
          (value) =>
            value !== null &&
            value !== undefined
        )
    ),
  ];

  const uniqueNegativeMarks = [
    ...new Set(
      rawQuestions
        .map(
          (question) =>
            question.negMarks
        )
        .filter(
          (value) =>
            value !== null &&
            value !== undefined
        )
    ),
  ];

  const cleanPaper = {
    schemaVersion:
      1,

    paper: {
      slug:
        paperSlug,

      title:
        paperTitle,

      exam:
        firstQuestion.exam,

      year:
        firstQuestion.year,

      language:
        "en",

      totalQuestions:
        cleanQuestions.length,

      subjects:
        Object.entries(
          subjectQuestionNumbers
        ).map(
          ([
            subjectName,
            questionCount,
          ]) => {
            return {
              name:
                subjectName,

              questionCount,
            };
          }
        ),

      defaultMarkingScheme: {
        correctMarks:
          uniqueMarks.length === 1
            ? uniqueMarks[0]
            : null,

        negativeMarks:
          uniqueNegativeMarks.length ===
          1
            ? uniqueNegativeMarks[0]
            : null,
      },
    },

    questions:
      cleanQuestions,
  };

  const validationReport =
    validatePaper(cleanPaper);

  writeJson(
    finalJsonPath,
    cleanPaper
  );

  /*
   * Store manifest and validation beside images,
   * but not inside the JSON output folder.
   */
  const manifestPath = path.join(
    paperImageDirectory,
    "image-manifest.json"
  );

  const validationPath = path.join(
    paperImageDirectory,
    "validation-report.json"
  );

  writeJson(
    manifestPath,
    {
      paper:
        paperSlug,

      totalImageOccurrences:
        imageManifest.length,

      failedDownloads:
        imageFailures.length,

      images:
        imageManifest,

      failures:
        imageFailures,
    }
  );

  writeJson(
    validationPath,
    validationReport
  );

  console.log(
    "\nConversion completed"
  );

  console.log(
    "--------------------"
  );

  console.log(
    `Final JSON: ${finalJsonPath}`
  );

  console.log(
    `Image folder: ${paperImageDirectory}`
  );

  console.log(
    `Image manifest: ${manifestPath}`
  );

  console.log(
    `Validation report: ${validationPath}`
  );

  console.log(
    `Total questions: ${cleanQuestions.length}`
  );

  console.log(
    `Image occurrences: ${imageManifest.length}`
  );

  console.log(
    `Image download failures: ${imageFailures.length}`
  );

  console.log(
    `JSON valid: ${validationReport.isValid}`
  );
}

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

convertPaper().catch((error) => {
  console.error(
    `\nConversion failed:\n${error.message}`
  );

  process.exit(1);
});