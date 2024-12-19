const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const app = express();
const port = 3000;
const fs = require("fs");
const axios = require("axios");
const { PDFDocument } = require("pdf-lib");
require('dotenv').config();
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const ADMIN_API_ACCESS_TOKEN = process.env.ADMIN_API_ACCESS_TOKEN;
const adminApiUrl = `${SHOPIFY_STORE_URL}/admin/api/2024-10/graphql.json`;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage: storage });
app.use(express.static(path.join(__dirname, "examples")));
// app.post('/upload', upload.single('pdf'), (req, res) => {
//     const filename = req.file.filename;

//     res.send({message:"File uploaded successfully",Filename:filename});
// });

// app.post("/upload", upload.single("pdf"), async (req, res) => {
//   const {book_coverFront,book_coverBack} = req.body;

//     try {
//       const filename = req.file.filename;
//       const filePath = path.join(__dirname, "uploads", filename);
  
//       // Load the existing PDF
//       const pdfDoc = await PDFDocument.load(fs.readFileSync(filePath));
  
//       // Embed the image to be added to the pages
//       const img = await pdfDoc.embedPng(book_coverFront);
  
//       // Insert a new page at the beginning of the PDF
//       const imagePageFront = pdfDoc.insertPage(0);
//       imagePageFront.drawImage(img, {
//         x: 0,
//         y: 0,
//         width: imagePageFront.getWidth(),
//         height: imagePageFront.getHeight(),
//       });
  
//       const img2 = await pdfDoc.embedPng(book_coverBack);
  
//       // Insert a new page at the end of the PDF
//       const imagePageBack = pdfDoc.addPage(); // addPage() adds at the end
//       imagePageBack.drawImage(img2, {
//         x: 0,
//         y: 0,
//         width: imagePageBack.getWidth(),
//         height: imagePageBack.getHeight(),
//       });
  
//       // Save the modified PDF to a new file
//       const pdfBytes = await pdfDoc.save();
//       const newFilename = `${path.basename(filePath, ".pdf")}-result.pdf`;
//       const newFilePath = path.join(__dirname, "uploads", newFilename);
//       fs.writeFileSync(newFilePath, pdfBytes);
  
//       // Respond with only the new file name
//       res.send({
//         message: "File uploaded and modified successfully",
//         Filename: newFilename, // only return the filename, not the full path
//       });
//     } catch (error) {
//       console.error(error);
//       res.status(500).send({ message: "An error occurred while processing the PDF." });
//     }
//   });


app.post("/upload", upload.single("pdf"), async (req, res) => {
  const { book_coverFront, book_coverBack } = req.body;
  const filename = req.file.filename;
  const filePath = path.join(__dirname, "uploads", filename);

  try {
    const pdfDoc = await PDFDocument.load(fs.readFileSync(filePath));

    // Embed the images to be added to the pages
    const imgFront = await pdfDoc.embedPng(book_coverFront);
    const imagePageFront = pdfDoc.insertPage(0);
    imagePageFront.drawImage(imgFront, {
      x: 0,
      y: 0,
      width: imagePageFront.getWidth(),
      height: imagePageFront.getHeight(),
    });

    const imgBack = await pdfDoc.embedPng(book_coverBack);
    const imagePageBack = pdfDoc.addPage();
    imagePageBack.drawImage(imgBack, {
      x: 0,
      y: 0,
      width: imagePageBack.getWidth(),
      height: imagePageBack.getHeight(),
    });

    // Save the modified PDF to a new file
    const pdfBytes = await pdfDoc.save();
    const newFilename = `${path.basename(filePath, ".pdf")}-result.pdf`;
    const newFilePath = path.join(__dirname, "uploads", newFilename);
    fs.writeFileSync(newFilePath, pdfBytes);

    // Upload to Shopify
    await uploadFileToShopify(newFilePath);

    // Respond with the new file name
    res.send({
      message: "File uploaded, modified, and uploaded to Shopify successfully",
      Filename: newFilename,
    });
  } catch (error) {
    console.error("Error in processing file:", error);
    res.status(500).send({ message: "An error occurred while processing the PDF." });
  }
});

const uploadFileToShopify = async (filePath) => {
  try {
    // Read file details
    const fileName = path.basename(filePath);
    const fileType = 'application/pdf'; // MIME type for PDF
    const fileSize = fs.statSync(filePath).size.toString();
    const fileStream = fs.createReadStream(filePath);

    // Step 1: Generate Staged Upload URL
    const stagedUploadsQuery = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            resourceUrl
            url
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    const stagedUploadsVariables = {
      input: [
        {
          resource: 'FILE',
          filename: fileName,
          mimeType: fileType,
          fileSize: fileSize,
          httpMethod: 'POST',
        }
      ]
    };

    const stagedUploadsResponse = await axios.post(
      adminApiUrl,
      {
        query: stagedUploadsQuery,
        variables: stagedUploadsVariables,
      },
      {
        headers: {
          'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
        },
      }
    );

    const target = stagedUploadsResponse.data.data.stagedUploadsCreate.stagedTargets[0];
    const uploadUrl = target.url;
    const resourceUrl = target.resourceUrl;
    const parameters = target.parameters;

    console.log('Staged upload URL created successfully.');

    // Step 2: Upload the file to the staged upload URL
    const FormData = require('form-data');
    const formData = new FormData();
    parameters.forEach(({ name, value }) => {
      formData.append(name, value);
    });
    formData.append('file', fileStream, fileName);

    await axios.post(uploadUrl, formData, {
      headers: formData.getHeaders(),
    });

    console.log('PDF file uploaded to staged URL successfully.');

    // Step 3: Register the file in Shopify
    await createFileInShopify(resourceUrl);
  } catch (error) {
    console.error('Error during upload:', error.message);
  }
};

const createFileInShopify = async (resourceUrl) => {
    const createFileQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          fileStatus
          ... on MediaImage {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const createFileVariables = {
    files: [
      {
        alt: 'Uploaded PDF File',
        contentType: 'FILE',
        originalSource: resourceUrl,
      },
    ],
  };

  const response = await axios.post(
    adminApiUrl,
    {
      query: createFileQuery,
      variables: createFileVariables,
    },
    {
      headers: {
        'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
      },
    }
  );

  const fileId = response.data.data.fileCreate.files[0].id;
  console.log('PDF file registered in Shopify successfully. File ID:', fileId);

  await fetchFileDetails(fileId);
};

const fetchFileDetails = async (fileId) => {
  const query = `
    query getFileByID($fileId: ID!) {
      node(id: $fileId) {
        ... on GenericFile {
          id
          originalSource
        }
      }
    }
  `;

  const variables = { fileId };

  try {
    const response = await axios.post(
      adminApiUrl,
      {
        query,
        variables,
      },
      {
        headers: {
          'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
        },
      }
    );

    const fileDetails = response.data.data.node;
    console.log('Uploaded PDF File Details:', fileDetails);
  } catch (error) {
    console.error('Error fetching PDF file details:', error.message);
  }
};



  

// Serve the HTML form
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "examples", "index.html"));
});
app.post("/rate", async(req, res) => {
 const rate = req.body.rate
  try {
    const response = await axios.put(
      `${SHOPIFY_STORE_URL}/admin/api/2024-10/variants/45722719486210.json`,
      {
        variant: {
          id: 45722719486210,
          price: rate,
          compare_at_price: rate,
        },
      },
      {
        headers: {
          'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    res.send({data:response.data});
  } catch (error) {
    console.error('Error updating variant:', error.response?.data || error.message);
  }
});
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
