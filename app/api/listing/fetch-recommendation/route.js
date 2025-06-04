import PropertyListing from "@models/property_listing";
import { getServerSession } from "next-auth/next";
import { nextAuthOptions } from "@app/api/auth/[...nextauth]/route";
import { checkForFavourites } from "../user/[id]/route";
import { connectToDB } from "@utils/database";

//route to fetch the recommendations for  a property listing
export async function GET(req) {
  try {
    const url = new URL(req.url)
    const searchParams = new URLSearchParams(url.searchParams);
    //get the listing id from search params
    const property_listing_id = searchParams.get("id");
    await connectToDB();
    const similarListings = await findSimilarProperties(property_listing_id)
    return Response.json(similarListings, { status: 200 });
  } catch (error) {
    console.error(error);
    return Response.json(
      {
        error:
          error.message ||
          "Some error occurred while finding similar lsitings.",
      },
      { status: 500 }
    );
  }
}

async function findSimilarProperties(propertyId,  maxPriceDifference = 20) {
  const property = await PropertyListing.findById(propertyId);
  if (!property) throw new Error("Property not found");
  return await PropertyListing.aggregate([
    {
      // Step 1: Text Search on Title & Description
      $search: {
        index: "property_text_index",
        text: {
          query: property.property_title + " " + property.property_description,
          path: ["property_title", "property_description"],
          fuzzy: { maxEdits: 1 }, // Handles typos & paraphrasing
        },
      },
    },
    {
      // Step 2: Filter by price range
      $match: {
        _id : {$ne : property._id},
        price: { $gte: property.price * (1 - maxPriceDifference / 100), $lte: property.price * (1 + maxPriceDifference / 100) },
      },
    },
    {
      // Step 3: Compute Jaccard Similarity for Amenities
      $addFields: {
        commonAmenities: {
          $size: {
            $setIntersection: ["$amenities.value", property.amenities.map((a) => a.value)],
          },
        },
        totalAmenities: {
          $size: {
            $setUnion: ["$amenities.value", property.amenities.map((a) => a.value)],
          },
        },
      },
    },
    {
      $addFields: {
        amenitySimilarity: {
          $divide: ["$commonAmenities", "$totalAmenities"], // Jaccard similarity score
        },
      },
    },
    {
      // Step 4: Compute Weighted Similarity Score
      $addFields: {
        similarityScore: {
          $add: [
            { $multiply: [{ $divide: [{ $abs: { $subtract: ["$price", property.price] } }, property.price] }, -0.3] }, // Price similarity (-0.3 weight)
            { $multiply: [{ $divide: [{ $abs: { $subtract: ["$area", property.area] } }, property.area] }, -0.2] }, // Area similarity (-0.2 weight)
            { $multiply: ["$amenitySimilarity", 0.5] }, // Amenities similarity (0.5 weight)
            { $multiply: [{ $divide: [{ $abs: { $subtract: ["$bedrooms", property.bedrooms] } }, property.bedrooms] }, -0.1] }, // Bedroom similarity (-0.1 weight)
          ],
        },
      },
    },
    {
      // Step 5: Sort by Most Similar
      $sort: { similarityScore: -1 },
    },
    {
      // Step 6: Limit Results
      $limit: 10,
    },
    {
      // Step 7: Lookup to populate the creator (User)
      $lookup: {
        from: "users", // MongoDB collection name for User
        localField: "creator",
        foreignField: "_id",
        as: "creator",
      },
    },
    {
      // Step 8: Unwind creator array (convert to object)
      $unwind: {
        path: "$creator",
        preserveNullAndEmptyArrays: true, // Keep property even if no user found
      },
    },
  ]);
}
